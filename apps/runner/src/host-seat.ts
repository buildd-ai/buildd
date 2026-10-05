/**
 * The runner machine's own Claude subscription login ("host seat").
 *
 * A runner whose machine is configured with its own model login gives that
 * login to its agents (when it wins over a seat stored in buildd: see
 * "Precedence" below). Two shapes count:
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
 * Precedence, set by `BUILDD_HOST_SEAT` on the runner:
 *
 * - unset / `auto` (default): the machine's seat is used whenever the claim
 *   delivers no stored seat. When the claim does deliver one, the stored seat
 *   is used and the agent env is exactly what it was before this module
 *   existed, so a runner that relies on a stored seat sees no change.
 * - `prefer`: the machine's seat wins over a stored seat. Set it once the
 *   machine's login is known to work (run one real `claude -p` with it).
 * - `off`: the machine's env token is never given to the agent; a stored seat
 *   is used as before.
 *

 * This module never reads or returns a token value. It only says whether one
 * is present.
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as childProcess from 'child_process';

export type HostSeat = 'env' | 'login';

export const HOST_SEAT_ENV = 'BUILDD_HOST_SEAT';
export const HOST_SEAT_TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';
const MAC_KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface HostSeatProbe {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  /** Whether the macOS keychain holds a Claude Code login. Injected in tests. */
  macKeychainHasLogin?: () => boolean;
}

export type HostSeatMode = 'auto' | 'prefer' | 'off';

export function hostSeatMode(env: Record<string, string | undefined> = process.env): HostSeatMode {
  const v = (env[HOST_SEAT_ENV] ?? '').trim().toLowerCase();
  return v === 'off' || v === 'prefer' ? v : 'auto';
}

export function hostSeatDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return hostSeatMode(env) === 'off';
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

/** Which host seat this runner machine has, or null. Honors `BUILDD_HOST_SEAT=off`. */
export function detectHostSeat(probe: HostSeatProbe = {}): HostSeat | null {
  const env = probe.env ?? process.env;
  if (hostSeatDisabled(env)) return null;
  if ((env[HOST_SEAT_TOKEN_VAR] ?? '').trim().length > 0) return 'env';
  const home = probe.home ?? homedir();
  if (credentialsFileHasLogin(home)) return 'login';
  const platform = probe.platform ?? process.platform;
  if (platform === 'darwin' && (probe.macKeychainHasLogin ?? defaultMacKeychainHasLogin)()) return 'login';
  return null;
}

export interface HostSeatDecision {
  /** The machine's seat, when it is the one the agent gets. Pass to applyModelEnv. */
  hostSeat: HostSeat | null;
  /** The machine has a seat but a stored seat was used instead (mode `auto`). */
  deferredTo: 'server' | null;
  /** The machine's seat that was detected, used or not. */
  detected: HostSeat | null;
  mode: HostSeatMode;
}

/**
 * Decide whose Claude seat the agent gets, and make the agent env match.
 * Mutates `env` (built from the passthrough): the machine's env token is
 * removed unless the machine's seat is the one being used, so with a stored
 * seat under `auto` the env is identical to the pre-passthrough one.
 */
export function applyHostSeatPolicy(
  env: Record<string, string>,
  opts: { serverSeatDelivered: boolean; isCodexTask?: boolean; probe?: HostSeatProbe },
): HostSeatDecision {
  const runnerEnv = opts.probe?.env ?? process.env;
  const mode = hostSeatMode(runnerEnv);
  const detected = mode === 'off' ? null : detectHostSeat(opts.probe ?? {});
  const use = !opts.isCodexTask && !!detected && (mode === 'prefer' || !opts.serverSeatDelivered);
  if (!use && (mode === 'off' || opts.serverSeatDelivered)) delete env[HOST_SEAT_TOKEN_VAR];
  return {
    hostSeat: use ? detected : null,
    deferredTo: !use && detected && opts.serverSeatDelivered && !opts.isCodexTask ? 'server' : null,
    detected,
    mode,
  };
}

/** Human-readable source label for the runner log. Never includes a value. */
export function describeHostSeat(seat: HostSeat): string {
  return seat === 'env'
    ? "this machine's own login (CLAUDE_CODE_OAUTH_TOKEN in the runner environment)"
    : "this machine's own login (claude login on the runner host)";
}

/** Machine-level model credential variables the agent env can inherit through the passthrough. */
export const HOST_MODEL_CREDENTIAL_VARS = [
  HOST_SEAT_TOKEN_VAR, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
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

export type CodexSeatChoice = 'machine' | 'server' | 'none';

/**
 * Whose Codex login a Codex task gets. Same modes as the Claude seat:
 * - `auto`: the machine's login when the claim delivers no Codex credential;
 *   a delivered credential is used as before.
 * - `prefer`: the machine's login also beats a delivered ChatGPT (OAuth)
 *   credential. A delivered API key is metered usage the team chose, and is
 *   still used.
 * - `off`: the old behaviour: the machine's login only through an explicitly
 *   set `CODEX_HOME`, and only with no delivered credential.
 */
export function decideCodexSeat(opts: {
  mode: HostSeatMode;
  serverCredentialType?: 'oauth' | 'api_key' | null;
  localAuthPath: string | null;
  explicitCodexHome: boolean;
}): CodexSeatChoice {
  const { mode, serverCredentialType, localAuthPath } = opts;
  const machineAvailable = !!localAuthPath && (mode !== 'off' || opts.explicitCodexHome);
  if (!serverCredentialType) return machineAvailable ? 'machine' : 'none';
  if (mode === 'prefer' && serverCredentialType === 'oauth' && machineAvailable) return 'machine';
  return 'server';
}
