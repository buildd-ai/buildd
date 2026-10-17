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
import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as childProcess from 'child_process';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { codexAuthJsonKind } from './cost-basis';

const execFileAsync = promisify(execFile);

export type MachineLogin = 'env' | 'login';

export const MACHINE_LOGIN_TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';
const MAC_KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface MachineLoginProbe {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  /** Whether the macOS keychain holds a Claude Code login. Injected in tests. */
  macKeychainHasLogin?: () => boolean;
  /** Async version for request paths. Injected in tests. */
  macKeychainHasLoginAsync?: () => Promise<boolean>;
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

let keychainStampCache: { at: number; value: string | null } | undefined;

/**
 * The macOS keychain item's modification date (`mdat`), or null. Attributes
 * only: no `-w`, so the secret is never printed. Cached like the presence check.
 */
export function defaultMacKeychainStamp(): string | null {
  const now = Date.now();
  if (keychainStampCache && now - keychainStampCache.at < KEYCHAIN_CACHE_MS) return keychainStampCache.value;
  let value: string | null = null;
  try {
    const r = childProcess.spawnSync('security', ['find-generic-password', '-s', MAC_KEYCHAIN_SERVICE], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      encoding: 'utf-8',
    });
    if (r.status === 0) value = parseKeychainMdat(String(r.stdout ?? ''));
  } catch {
    value = null;
  }
  keychainStampCache = { at: now, value };
  return value;
}

let keychainHasLoginRefreshTimeout: NodeJS.Timeout | undefined;
let keychainStampRefreshTimeout: NodeJS.Timeout | undefined;

/**
 * Async version: spawn without blocking the event loop. Never blocks on a sync call.
 * Returns cached value immediately (or false/null if no cache exists yet).
 * Background refresh: after cache expires, refresh in the background and keep serving the last value.
 */
export async function defaultMacKeychainHasLoginAsync(): Promise<boolean> {
  const now = Date.now();
  const cached = keychainCache && now - keychainCache.at < KEYCHAIN_CACHE_MS;

  // Cache is still fresh, return it
  if (cached) return keychainCache!.value;

  // Cache expired; start a background refresh if not already running
  if (!keychainHasLoginRefreshTimeout) {
    keychainHasLoginRefreshTimeout = setTimeout(() => {
      keychainHasLoginRefreshTimeout = undefined;
      defaultMacKeychainHasLoginAsync().catch(() => {
        // Ignore errors from background refresh
      });
    }, 0);
  }

  // Return stale cached value immediately, or false if no cache yet
  if (keychainCache) return keychainCache.value;

  // First call ever: block once to get initial value
  let value = false;
  try {
    const r = await execFileAsync('security', ['find-generic-password', '-s', MAC_KEYCHAIN_SERVICE], {
      stdio: 'ignore',
      timeout: 3000,
    });
    value = r && true;
  } catch {
    value = false;
  }
  keychainCache = { at: now, value };
  return value;
}

/**
 * Async version: spawn without blocking the event loop. Never blocks on a sync call.
 * Returns cached value immediately (or null if no cache exists yet).
 * Background refresh: after cache expires, refresh in the background and keep serving the last value.
 */
export async function defaultMacKeychainStampAsync(): Promise<string | null> {
  const now = Date.now();
  const cached = keychainStampCache && now - keychainStampCache.at < KEYCHAIN_CACHE_MS;

  // Cache is still fresh, return it
  if (cached) return keychainStampCache!.value;

  // Cache expired; start a background refresh if not already running
  if (!keychainStampRefreshTimeout) {
    keychainStampRefreshTimeout = setTimeout(() => {
      keychainStampRefreshTimeout = undefined;
      defaultMacKeychainStampAsync().catch(() => {
        // Ignore errors from background refresh
      });
    }, 0);
  }

  // Return stale cached value immediately, or null if no cache yet
  if (keychainStampCache) return keychainStampCache.value;

  // First call ever: block once to get initial value
  let value: string | null = null;
  try {
    const r = await execFileAsync('security', ['find-generic-password', '-s', MAC_KEYCHAIN_SERVICE], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    if (r && r.stdout) value = parseKeychainMdat(String(r.stdout));
  } catch {
    value = null;
  }
  keychainStampCache = { at: now, value };
  return value;
}

/** The `"mdat"<timedate>=... "20261016093000Z\000"` attribute line's date, or null. */
export function parseKeychainMdat(attributes: string): string | null {
  const m = /"mdat"<timedate>=(?:0x[0-9A-Fa-f]+\s+)?"([^"]+)"/.exec(attributes);
  return m ? m[1] : null;
}

function mtimeOf(path: string): string | null {
  try { return existsSync(path) ? String(statSync(path).mtimeMs) : null; } catch { return null; }
}

/**
 * A stamp of where this machine keeps a backend's login, which changes when
 * the login is redone (`claude login`, `codex login`): the Claude credentials
 * file's mtime and, on macOS, the keychain item's modification date; the Codex
 * auth.json's mtime. Never a value. Null when nothing readable holds one.
 */
export function machineLoginStamp(
  backend: 'claude' | 'codex',
  probe: { env?: Record<string, string | undefined>; home?: string; platform?: NodeJS.Platform; macKeychainStamp?: () => string | null } = {},
): string | null {
  const env = probe.env ?? process.env;
  const home = probe.home ?? homedir();
  if (backend === 'codex') return mtimeOf(join(resolveLocalCodexHome(env, home), 'auth.json'));
  const file = mtimeOf(join(home, '.claude', '.credentials.json'));
  const platform = probe.platform ?? process.platform;
  const keychain = platform === 'darwin' ? (probe.macKeychainStamp ?? defaultMacKeychainStamp)() : null;
  return file === null && keychain === null ? null : `${file ?? '-'}|${keychain ?? '-'}`;
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

/** Async version: never blocks on sync keychain checks. Always returns immediately with cached or absent value. */
export async function detectMachineLoginAsync(probe: MachineLoginProbe = {}): Promise<MachineLogin | null> {
  const env = probe.env ?? process.env;
  if ((env[MACHINE_LOGIN_TOKEN_VAR] ?? '').trim().length > 0) return 'env';
  const home = probe.home ?? homedir();
  if (credentialsFileHasLogin(home)) return 'login';
  const platform = probe.platform ?? process.platform;
  if (platform === 'darwin' && await (probe.macKeychainHasLoginAsync ?? defaultMacKeychainHasLoginAsync)()) {
    return 'login';
  }
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

/** Stable prefix of the pre-spawn refusal below, so a failure list can group it. */
export const NO_MODEL_AUTH_ERROR_CODE = '[runner:no_model_auth]';

const MODEL_AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', MACHINE_LOGIN_TOKEN_VAR] as const;

/**
 * Pre-spawn check for a Claude run (model credentials spec R-5 / AC-5): the
 * refusal text when nothing can authenticate it, else null. Only a run headed
 * for Anthropic is judged; a team endpoint or a custom host decides its own
 * auth. Anything counts: the machine's seat, a model variable left in the
 * agent env (the machine's or one the claim delivered), the claim's Claude
 * credential written into the session, or a `claude login` the CLI will find
 * through the agent's HOME.
 */
export function claudeModelAuthMissing(input: {
  isCodexTask: boolean;
  /** applyModelEnv's result. */
  modelEnv: { endpoint: string; machineLoginUsed?: boolean };
  /** The agent env, after applyModelEnv. */
  env: Record<string, string | undefined>;
  /** shouldUseClaudeCredential for this run. */
  claudeCredentialUsed: boolean;
  /** Login probe; `home` defaults to the agent env's HOME. Injected in tests. */
  probe?: Omit<MachineLoginProbe, 'env'>;
}): string | null {
  if (input.isCodexTask) return null;
  if (input.modelEnv.endpoint !== 'anthropic') return null;
  if (input.modelEnv.machineLoginUsed || input.claudeCredentialUsed) return null;
  if (MODEL_AUTH_VARS.some((k) => (input.env[k] ?? '').trim().length > 0)) return null;
  const home = input.probe?.home ?? input.env.HOME;
  if (detectMachineLogin({ ...input.probe, ...(home ? { home } : {}), env: {} }) === 'login') return null;
  return `${NO_MODEL_AUTH_ERROR_CODE} No model login for this Claude run: this runner has no Claude login `
    + 'or API key of its own, and the claim delivered none. The task is left for a runner that has one. '
    + `To fix: ${NO_MODEL_AUTH_FIX}`;
}

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
