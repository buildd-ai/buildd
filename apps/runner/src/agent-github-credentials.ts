/**
 * Task-scoped GitHub credentials for an agent on a self-hosted runner.
 *
 * When the claim says `githubCredentials.mode = 'scoped'`
 * (@buildd/core/agent-github-credentials), the agent must act on GitHub with
 * the short-lived installation token the server mints for its task's repo,
 * and nothing the runner's host already holds. Three things make that so:
 *
 *  - Inherited GitHub tokens (GITHUB_TOKEN, GH_TOKEN, ...) leave the agent env.
 *  - git: config passed through GIT_CONFIG_COUNT, the command-line level, which
 *    outranks system, global and repo-local files. It empties the credential
 *    helper list (an empty `credential.helper` resets it, URL-specific
 *    helpers included) and installs one helper that answers for github.com
 *    from a token file. GitHub SSH remotes are rewritten to https so host SSH
 *    keys are not used, and any extra auth header is cleared. Everything else
 *    in the host's git config (identity, LFS filters) still applies.
 *  - gh: GH_CONFIG_DIR points at a private dir whose hosts.yml holds the token.
 *
 * Both the token file and hosts.yml are rewritten on refresh, so a session
 * longer than the token's hour keeps working: git and gh read them on every
 * call, while an env var would be fixed at spawn.
 *
 * Files live under the session's throwaway runner home (agent-runner-home.ts),
 * created 0700/0600, removed with it.
 */
// Namespace import: many runner tests mock.module('fs') with a partial stub.
import * as fs from 'fs';
import { join } from 'path';

/** GitHub tokens a runner's env might carry; none reach a scoped agent. */
export const INHERITED_GITHUB_TOKEN_ENV = ['GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const;

export interface ScopedGitHubFiles {
  dir: string;
  tokenPath: string;
  helperPath: string;
  ghConfigDir: string;
}

/** Installation tokens are `ghs_` + base62; anything else is refused rather than written. */
const TOKEN_RE = /^[A-Za-z0-9_.-]{1,512}$/;

function helperScript(tokenPath: string): string {
  return [
    '#!/bin/sh',
    '# buildd: task-scoped GitHub credential for this agent session.',
    '# The runner rewrites the token file before the token expires.',
    '[ "$1" = get ] || exit 0',
    'host=',
    'while IFS= read -r line; do',
    '  [ -z "$line" ] && break',
    '  case "$line" in host=*) host=${line#host=} ;; esac',
    'done',
    '[ "$host" = github.com ] || exit 0',
    `token=$(cat '${tokenPath}' 2>/dev/null)`,
    '[ -n "$token" ] || exit 0',
    'printf \'username=x-access-token\\npassword=%s\\n\' "$token"',
    '',
  ].join('\n');
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, path);
}

function appendGitConfig(env: Record<string, string>, entries: Array<[string, string]>): void {
  let count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  if (!Number.isFinite(count) || count < 0) count = 0;
  for (const [key, value] of entries) {
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count}`] = value;
    count++;
  }
  env.GIT_CONFIG_COUNT = String(count);
}

/**
 * Strip inherited GitHub credentials from `env` and point the agent's git and
 * gh at `dir`. No token is written yet: until writeScopedGitHubToken runs,
 * github.com gets no credential at all (never the operator's). Mutates `env`.
 */
export function applyScopedGitHubEnv(env: Record<string, string>, dir: string): ScopedGitHubFiles {
  if (dir.includes("'")) throw new Error('scoped GitHub credential dir must not contain a quote');
  for (const key of INHERITED_GITHUB_TOKEN_ENV) delete env[key];

  const files: ScopedGitHubFiles = {
    dir,
    tokenPath: join(dir, 'token'),
    helperPath: join(dir, 'git-credential-buildd'),
    ghConfigDir: join(dir, 'gh'),
  };
  fs.mkdirSync(files.ghConfigDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(files.helperPath, helperScript(files.tokenPath), { mode: 0o700 });

  appendGitConfig(env, [
    ['credential.helper', ''],
    ['credential.helper', `!'${files.helperPath}'`],
    ['url.https://github.com/.insteadOf', 'git@github.com:'],
    ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
    ['http.https://github.com/.extraHeader', ''],
  ]);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.GH_CONFIG_DIR = files.ghConfigDir;
  return files;
}

export function writeScopedGitHubToken(files: ScopedGitHubFiles, token: string): void {
  if (!TOKEN_RE.test(token)) throw new Error('refusing to write a GitHub token with unexpected characters');
  writeAtomic(files.tokenPath, token);
  writeAtomic(join(files.ghConfigDir, 'hosts.yml'), [
    'github.com:',
    `    oauth_token: ${token}`,
    '    user: x-access-token',
    '    git_protocol: https',
    '',
  ].join('\n'));
}

export function clearScopedGitHubToken(files: ScopedGitHubFiles): void {
  try { fs.rmSync(files.tokenPath, { force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(join(files.ghConfigDir, 'hosts.yml'), { force: true }); } catch { /* best-effort */ }
}

export interface ScopedGitHubTokenResult {
  token: string;
  expiresAt: Date;
}

/** An error the fetcher marks `permanent` (e.g. no linked repo) ends retrying. */
export type ScopedGitHubStartResult = { ok: true } | { ok: false; reason: string; permanent?: boolean };

const REFRESH_BEFORE_MS = 5 * 60_000;
const MIN_DELAY_MS = 30_000;

/**
 * Keeps the session's token fresh: fetches on start, refetches five minutes
 * before expiry, retries after a failure. A failed refresh leaves the current
 * token in place; it stays valid until its own expiry.
 */
export class ScopedGitHubTokenRefresher {
  private timer: unknown = null;
  private stopped = false;

  constructor(private readonly opts: {
    files: ScopedGitHubFiles;
    fetchToken: () => Promise<ScopedGitHubTokenResult>;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (id: unknown) => void;
    retryMs?: number;
    log?: (msg: string) => void;
  }) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }

  private schedule(ms: number): void {
    if (this.stopped) return;
    const set = this.opts.setTimer ?? ((fn: () => void, d: number) => {
      const t = setTimeout(fn, d);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    this.timer = set(() => { this.timer = null; void this.refresh(); }, ms);
  }

  private async refresh(): Promise<ScopedGitHubStartResult> {
    if (this.stopped) return { ok: false, reason: 'stopped' };
    try {
      const { token, expiresAt } = await this.opts.fetchToken();
      if (this.stopped) return { ok: false, reason: 'stopped' };
      writeScopedGitHubToken(this.opts.files, token);
      this.schedule(Math.max(MIN_DELAY_MS, expiresAt.getTime() - REFRESH_BEFORE_MS - this.now()));
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const permanent = !!(err as { permanent?: unknown })?.permanent;
      this.opts.log?.(`task-scoped GitHub token ${permanent ? 'refused' : 'fetch failed, will retry'}: ${reason}`);
      if (permanent) return { ok: false, reason, permanent: true };
      this.schedule(this.opts.retryMs ?? 60_000);
      return { ok: false, reason };
    }
  }

  start(): Promise<ScopedGitHubStartResult> {
    return this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      (this.opts.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
    }
    clearScopedGitHubToken(this.opts.files);
  }
}

export interface ScopedGitHubSession {
  ok: boolean;
  /** Why the agent has no GitHub credential, when !ok. */
  reason?: string;
  stop: () => void;
}

/**
 * Set up one agent session's scoped GitHub access under `homeDir` and fetch
 * the first token. Fails closed: whatever goes wrong, inherited GitHub
 * tokens are already gone from `env`, so the agent ends up with no GitHub
 * credential rather than the operator's.
 */
export async function startScopedGitHubSession(opts: {
  env: Record<string, string>;
  homeDir: string;
  fetchToken: () => Promise<ScopedGitHubTokenResult>;
  log?: (msg: string) => void;
}): Promise<ScopedGitHubSession> {
  for (const key of INHERITED_GITHUB_TOKEN_ENV) delete opts.env[key];
  let files: ScopedGitHubFiles;
  try {
    files = applyScopedGitHubEnv(opts.env, join(opts.homeDir, 'github'));
  } catch (err) {
    const reason = `could not prepare GitHub credential files: ${err instanceof Error ? err.message : String(err)}`;
    opts.log?.(reason);
    return { ok: false, reason, stop: () => {} };
  }
  const refresher = new ScopedGitHubTokenRefresher({ files, fetchToken: opts.fetchToken, log: opts.log });
  const started = await refresher.start();
  return started.ok
    ? { ok: true, stop: () => refresher.stop() }
    : { ok: false, reason: started.reason, stop: () => refresher.stop() };
}
