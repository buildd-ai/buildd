/**
 * The runner machine's own Claude subscription login ("host seat").
 *
 * A runner whose machine is configured with its own model login gives that
 * login to its agents, and it wins over a seat the server delivers on the
 * claim. Two shapes count:
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
 * Escape hatch: `BUILDD_HOST_SEAT=off` on the runner restores the old order (a
 * server-delivered seat is used and the machine's env token is not given to the
 * agent). It exists so an operator whose machine login turns out to be stale
 * can switch back with a restart instead of waiting for a release.
 *
 * This module never reads or returns a token value. It only says whether one
 * is present.
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

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

export function hostSeatDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env[HOST_SEAT_ENV] ?? '').trim().toLowerCase() === 'off';
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
    const r = spawnSync('security', ['find-generic-password', '-s', MAC_KEYCHAIN_SERVICE], {
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

/**
 * Apply the escape hatch to an agent env built from the passthrough: with
 * `BUILDD_HOST_SEAT=off`, the machine's env token is not given to the agent.
 * Mutates and returns `env`.
 */
export function applyHostSeatPolicy(
  env: Record<string, string>,
  runnerEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (hostSeatDisabled(runnerEnv)) delete env[HOST_SEAT_TOKEN_VAR];
  return env;
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
