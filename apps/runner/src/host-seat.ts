/**
 * The runner machine's own Claude subscription login.
 *
 * A runner whose machine is configured with its own model login gives that
 * login to its agents. Two shapes count:
 *
 * - `env`: `CLAUDE_CODE_OAUTH_TOKEN` is set in the runner's environment (a
 *   `claude setup-token` value exported in the service env, a container env, a
 *   Coder parameter...). It reaches the agent through `RUNNER_ENV_PASSTHROUGH`.
 * - `login`: `claude login` has been run as the runner's user, so the Claude
 *   CLI finds a subscription login under `$HOME` (`~/.claude/.credentials.json`
 *   with a `claudeAiOauth` entry on Linux, the `Claude Code-credentials`
 *   keychain item on macOS). `HOME` already passes through.
 *
 * A stub `~/.claude.json` `oauthAccount` or a credentials file holding only
 * MCP OAuth entries is NOT a login, so neither counts.
 *
 * This module never reads or returns a token value. It only says whether one
 * is present.
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as childProcess from 'child_process';
import { codexAuthJsonKind } from './cost-basis';

export type MachineLogin = 'env' | 'login';

export const MACHINE_LOGIN_TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';
const MAC_KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface MachineLoginProbe {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  /** Whether the macOS keychain holds a Claude Code login. Injected in tests. */
  macKeychainHasLogin?: () => boolean;
}

/** True when `~/.claude/.credentials.json` holds a Claude subscription login (not just MCP OAuth). */
export function credentialsFileHasLogin(home: string): boolean {
  const path = join(home, '.claude', '.credentials.json');
  if (!existsSync(path)) return false;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    const oauth = data?.claudeAiOauth;
    return !!oauth && typeof oauth === 'object' &&
      ((typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0) ||
        (typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0));
  } catch {
    return false;
  }
}

let keychainCache: { at: number; value: boolean } | undefined;
const KEYCHAIN_CACHE_MS = 60_000;

/**
 * Presence check only: `security find-generic-password` without `-w` prints the
 * item's attributes, never the secret, and its output is discarded.
 */
export function defaultMacKeychainHasLogin(): boolean {
  const now = Date.now();
  if (keychainCache && now - keychainCache.at < KEYCHAIN_CACHE_MS) return keychainCache.value;
  let value = false;
  try {
    const r = childProcess.spawnSync('security', ['find-generic-password', '-s', MAC_KEYCHAIN_SERVICE], {
      stdio: 'ignore',
      timeout: 3000,
    });
    value = r.status === 0;
  } catch {
    value = false;
  }
  keychainCache = { at: now, value };
  return value;
}

/** Which Claude login this runner machine has, or null. */
export function detectMachineLogin(probe: MachineLoginProbe = {}): MachineLogin | null {
  const env = probe.env ?? process.env;
  if ((env[MACHINE_LOGIN_TOKEN_VAR] ?? '').trim().length > 0) return 'env';
  const home = probe.home ?? homedir();
  if (credentialsFileHasLogin(home)) return 'login';
  const platform = probe.platform ?? process.platform;
  if (platform === 'darwin' && (probe.macKeychainHasLogin ?? defaultMacKeychainHasLogin)()) return 'login';
  return null;
}

export interface MachineLoginDecision {
  machineLogin: MachineLogin | null;
  detected: MachineLogin | null;
}

/** Use the machine's own login unless personal_only forbids local credentials. */
export function applyMachineLoginPolicy(
  env: Record<string, string>,
  opts: {
    isCodexTask?: boolean;
    probe?: MachineLoginProbe;
    /** personal_only: the requester's key must not be displaced by this machine's login. */
    runnerLocalAllowed?: boolean;
  },
): MachineLoginDecision {
  const detected = detectMachineLogin(opts.probe ?? {});
  const use = opts.runnerLocalAllowed !== false && !opts.isCodexTask && !!detected;
  if (!use) delete env[MACHINE_LOGIN_TOKEN_VAR];
  return { machineLogin: use ? detected : null, detected };
}

/** Report an obsolete setting once at startup; its value has no effect. */
export function reportIgnoredLoginSetting(env: Record<string, string | undefined> = process.env, log: (line: string) => void = console.log): void {
  if (env.BUILDD_HOST_SEAT !== undefined) log('BUILDD_HOST_SEAT no longer does anything; the runner uses this machine’s own model login when present.');
}

/** Human-readable source label for the runner log. Never includes a value. */
export function describeMachineLogin(seat: MachineLogin): string {
  return seat === 'env'
    ? "this machine's own login (CLAUDE_CODE_OAUTH_TOKEN in the runner environment)"
    : "this machine's own login (claude login on the runner host)";
}

// ─── The one model-auth detector (docs/specs/runner-model-login-detect-say-report.md) ───

/**
 * Which kind of credential this runner's Claude agent authenticates with for a
 * claim that delivers none. The startup line, the local /api/config and the
 * heartbeat label all come from `detectModelAuthSource`. A label, never a value.
 */
export type ModelAuthSource = 'machine_token' | 'machine_login' | 'api_key' | 'none';

export interface ModelAuthReport {
  source: ModelAuthSource;
}

/**
 * Precedence: machine_token > machine_login > api_key > none.
 * `BUILDD_MODEL_AUTH_SOURCE=runner` an inherited key is stripped from the agent
 * env unless an operator-set ANTHROPIC_BASE_URL selects a paid route
 * (model-auth-source.ts), so it is reported only in that case.
 */
export function detectModelAuthSource(probe: MachineLoginProbe = {}): ModelAuthReport {
  const env = probe.env ?? process.env;
  const seat = detectMachineLogin({ ...probe, env });
  if (seat === 'env') return { source: 'machine_token' };
  if (seat === 'login') return { source: 'machine_login' };
  const has = (name: string) => (env[name] ?? '').trim().length > 0;
  const runnerManaged = (env.BUILDD_MODEL_AUTH_SOURCE ?? '').trim().toLowerCase() === 'runner';
  const keyReachesAgent = !runnerManaged || has('ANTHROPIC_BASE_URL');
  if (keyReachesAgent && (has('ANTHROPIC_API_KEY') || has('ANTHROPIC_AUTH_TOKEN'))) return { source: 'api_key' };
  return { source: 'none' };
}

export const NO_MODEL_AUTH_FIX =
  'run `claude login` as the runner user, or set CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) '
  + 'for a headless machine, or ANTHROPIC_API_KEY for metered billing';

/** Human words for a model-auth label (the startup `Model auth: <words>` line). */
export function describeModelAuthSource(source: ModelAuthSource): string {
  switch (source) {
    case 'machine_token': return 'a Claude token set on this machine (CLAUDE_CODE_OAUTH_TOKEN)';
    case 'machine_login': return "this machine's Claude login";
    case 'api_key': return 'an API key (billed per token)';
    default: return `no model login on this machine. To fix: ${NO_MODEL_AUTH_FIX}`;
  }
}

/** Machine-level model credential variables the agent env can inherit through the passthrough. */
export const HOST_MODEL_CREDENTIAL_VARS = [
  MACHINE_LOGIN_TOKEN_VAR, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
] as const;

/**
 * Exact values for the worker's secret redactor: the machine's own model
 * credentials, so a token the agent echoes never reaches milestones, error
 * traces, evidence or the history archive.
 */
export function hostModelCredentialValues(
  env: Record<string, string | undefined> = process.env,
): Array<{ label: string; value: string }> {
  return HOST_MODEL_CREDENTIAL_VARS
    .map((label) => ({ label: `host:${label}`, value: (env[label] ?? '').trim() }))
    .filter((s) => s.value.length >= 8);
}

// ─── Codex: the machine's own Codex / ChatGPT login ─────────────────────────

/** The runner user's real Codex home: `$CODEX_HOME` when set, else `~/.codex`. */
export function resolveLocalCodexHome(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const explicit = (env.CODEX_HOME ?? '').trim();
  return explicit || join(home, '.codex');
}

/** `<local Codex home>/auth.json` when it exists (a `codex login` on this machine), else null. */
export function localCodexAuthPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string | null {
  const p = join(resolveLocalCodexHome(env, home), 'auth.json');
  return existsSync(p) ? p : null;
}

export type CodexLoginChoice = 'machine' | 'server' | 'none';

/** Use the machine's Codex login first; personal_only forbids local credentials. */
export function decideCodexLogin(opts: {
  serverCredentialType?: 'oauth' | 'api_key' | null;
  localAuthPath: string | null;
  runnerLocalAllowed?: boolean;
}): CodexLoginChoice {
  if (opts.runnerLocalAllowed !== false && opts.localAuthPath) return 'machine';
  return opts.serverCredentialType ? 'server' : 'none';
}

// ─── Codex auth label (docs/specs: runner model login, R-10/R-11) ──────────

/**
 * Which kind of Codex login this runner's Codex agent gets for a claim that
 * delivers no Codex credential. Sent as the heartbeat's `codexAuthSource`.
 * A label, never a value.
 */
export type CodexAuthSource = 'machine_login' | 'api_key' | 'none';

export interface CodexAuthProbe {
  env?: Record<string, string | undefined>;
  home?: string;
  /** Reads a file's text, or null when it is absent/unreadable. Injected in tests. */
  readFile?: (path: string) => string | null;
}

function readFileOrNull(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null;
  } catch {
    return null;
  }
}

/** Classify the machine's Codex auth.json, then the env API key. Never returns a value. */
export function detectCodexAuthSource(probe: CodexAuthProbe = {}): CodexAuthSource {
  const env = probe.env ?? process.env;
  const home = probe.home ?? homedir();
  const raw = (probe.readFile ?? readFileOrNull)(join(resolveLocalCodexHome(env, home), 'auth.json'));
  if (raw !== null) {
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const kind = codexAuthJsonKind(parsed);
    if (kind === 'chatgpt') return 'machine_login';
    if (kind === 'api_key') return 'api_key';
  }
  if ((env.OPENAI_API_KEY ?? '').trim().length > 0) return 'api_key';
  return 'none';
}

export const NO_CODEX_AUTH_FIX = 'run `codex login` as the runner user, or set OPENAI_API_KEY';

/** Human words for a Codex label (the startup `Codex auth: <words>` line). Not a warning: Codex is optional. */
export function describeCodexAuthSource(source: CodexAuthSource): string {
  switch (source) {
    case 'machine_login': return "this machine's Codex login";
    case 'api_key': return 'an OpenAI API key (billed per token)';
    default: return `no Codex login on this machine. To fix: ${NO_CODEX_AUTH_FIX}`;
  }
}
