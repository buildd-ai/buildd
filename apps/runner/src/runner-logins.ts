/**
 * How this runner's own logins share its slots (Living Spec 34a48877, "Which
 * login takes which work", R-14 to R-19).
 *
 *   - `buildd logins <mode>` / `b` in `buildd top` set the mode; `buildd
 *     logins` alone prints it and how each login is used now.
 *   - The mode is saved in config.json (`loginMode`), so every restart keeps
 *     it; balanced when never set. The heartbeat reports it, and every claim
 *     sends it with this runner's live agents per backend (loginUseFor): the
 *     server picks the backend for work nothing ties to one from those.
 *   - A change takes effect on the next claim; a running agent keeps its login.
 */
import { existsSync, readFileSync } from 'fs';
import { DEFAULT_LOGIN_MODE, LOGIN_MODES, backendShares, parseLoginMode, type LoginBackend, type LoginMode, type RunnerLoginUse } from '@buildd/shared';
import { writeSecretJsonFile } from './secure-file';
import { UnreadableConfigError } from './runner-name';
import { RUNNER_SOCKET_TIMEOUT_MS } from './runner-hold';
import type { SocketProbe } from './runner-socket';

import type { LoginsCommand } from './cli-args';
export { classifyLoginsArgs, type LoginsCommand } from './cli-args';

export const LOGINS_USAGE = 'Usage: buildd logins [balanced | claude-first | codex-first]';
const MODE_LIST = 'balanced, claude-first or codex-first';

// ── what a claim carries ───────────────────────────────────────────────────

/** A local agent, as far as the split cares. */
export interface LoginAgent { status: string; taskBackend?: string | null }

/** This runner's mode, slots and working agents per backend: the claim's `loginUse`. */
export function loginUseFor(mode: LoginMode, slots: number, agents: LoginAgent[]): RunnerLoginUse {
  const running: Record<LoginBackend, number> = { claude: 0, codex: 0 };
  for (const a of agents) {
    if (a.status !== 'working' && a.status !== 'stale') continue;
    running[a.taskBackend === 'codex' ? 'codex' : 'claude']++;
  }
  return { mode, slots, running };
}

// ── words ──────────────────────────────────────────────────────────────────

const NAME: Record<LoginBackend, string> = { claude: 'Claude', codex: 'Codex' };

/** `buildd logins` alone: the mode and how each login is used now. */
export function loginsStatusLine(mode: LoginMode, slots: number, running: Record<LoginBackend, number>): string {
  if (mode === 'balanced') {
    const share = backendShares(mode, slots);
    return `Login mode: balanced. Claude: ${running.claude} running (up to ${share.claude}). Codex: ${running.codex} running (up to ${share.codex}).`;
  }
  const first: LoginBackend = mode === 'claude-first' ? 'claude' : 'codex';
  const other: LoginBackend = first === 'claude' ? 'codex' : 'claude';
  const otherWords = running[other] > 0 ? `${running[other]} running` : `idle, takes work when ${NAME[first]} is at its limit`;
  return `Login mode: ${mode}. ${NAME[first]}: ${running[first]} running. ${NAME[other]}: ${otherWords}.`;
}

/** What a change says (R-19). */
export function loginModeChangeLine(mode: LoginMode): string {
  return `Login mode now ${mode}. Running agents keep their login; the next claim follows it.`;
}

// ── config.json ────────────────────────────────────────────────────────────

function readConfigObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Write `loginMode` into config.json, keeping every other field (refuses an unreadable file, which holds the API key). */
export function saveLoginModeToConfig(configFile: string, mode: LoginMode): void {
  let cfg: Record<string, unknown> = {};
  if (existsSync(configFile)) {
    const existing = readConfigObject(configFile);
    if (!existing) throw new UnreadableConfigError(configFile);
    cfg = existing;
  }
  cfg.loginMode = mode;
  writeSecretJsonFile(configFile, cfg);
}

/** The saved mode, or balanced when none (or a garbled one) is saved. */
export function readLoginModeFromConfig(configFile: string): LoginMode {
  return parseLoginMode(readConfigObject(configFile)?.loginMode) ?? DEFAULT_LOGIN_MODE;
}

// ── the CLI ────────────────────────────────────────────────────────────────

export interface LoginsCommandDeps {
  configFile: string;
  socketPath: string;
  probe?: (socketPath: string) => Promise<SocketProbe>;
  get?: (path: string) => Promise<{ status: number; body: unknown }>;
  post?: (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
}

export interface LoginsCommandResult { code: number; stdout: string; stderr: string }

async function socketCall(socketPath: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://localhost${path}`, {
    unix: socketPath,
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(RUNNER_SOCKET_TIMEOUT_MS),
  } as RequestInit);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

function refusal(body: unknown, status: number): string {
  const b = body as { error?: unknown } | null;
  const why = typeof body === 'string' ? body : typeof b?.error === 'string' ? b.error : '';
  return why ? `${why} (HTTP ${status})` : `HTTP ${status}`;
}

/**
 * `buildd logins [<mode>]`. With a runner on the socket it asks that runner (a
 * service included); with none it writes config.json for the next start.
 */
export async function runLoginsCommand(cmd: LoginsCommand, deps: LoginsCommandDeps): Promise<LoginsCommandResult> {
  let mode: LoginMode | null = null;
  if (cmd.kind === 'set') {
    mode = parseLoginMode(cmd.raw);
    if (!mode) return { code: 64, stdout: '', stderr: `The login mode is ${MODE_LIST}, not "${cmd.raw}". ${LOGINS_USAGE}` };
  }
  const probe = await (deps.probe ?? ((p: string) => import('./runner-socket').then(m => m.probeRunnerSocket(p))))(deps.socketPath);
  const get = deps.get ?? ((path: string) => socketCall(deps.socketPath, path));
  const post = deps.post ?? ((path: string, body: Record<string, unknown>) => socketCall(deps.socketPath, path, body));

  if (probe.state !== 'live') {
    if (cmd.kind === 'show') {
      return { code: 0, stdout: `No runner is running on this machine. The next start uses ${readLoginModeFromConfig(deps.configFile)}.`, stderr: '' };
    }
    try {
      saveLoginModeToConfig(deps.configFile, mode!);
    } catch (err) {
      if (err instanceof UnreadableConfigError) return { code: 1, stdout: '', stderr: err.message };
      throw err;
    }
    return { code: 0, stdout: `No runner is running on this machine. Saved: the next start uses ${mode}.`, stderr: '' };
  }

  if (cmd.kind === 'show') {
    try {
      const r = await get('/api/logins');
      if (r.status === 404) return { code: 1, stdout: '', stderr: 'The runner running now does not know login modes yet (update it).' };
      const b = r.body as { mode?: unknown; slots?: unknown; running?: { claude?: unknown; codex?: unknown } };
      const shown = parseLoginMode(b?.mode);
      if (r.status !== 200 || !shown) return { code: 1, stdout: '', stderr: `The runner did not say its login mode (${refusal(r.body, r.status)}).` };
      const n = (v: unknown) => (typeof v === 'number' ? v : 0);
      return { code: 0, stdout: loginsStatusLine(shown, typeof b.slots === 'number' ? b.slots : 1, { claude: n(b.running?.claude), codex: n(b.running?.codex) }), stderr: '' };
    } catch (err) {
      return { code: 1, stdout: '', stderr: `The runner on this machine did not answer (${(err as Error)?.message ?? err}).` };
    }
  }

  let res: { status: number; body: unknown };
  try {
    res = await post('/api/logins', { mode: mode! });
  } catch (err) {
    return { code: 1, stdout: '', stderr: `The runner on this machine did not answer (${(err as Error)?.message ?? err}). Nothing changed.` };
  }
  if (res.status === 404) return { code: 1, stdout: '', stderr: 'The runner running now does not know login modes yet (update it). Nothing changed.' };
  if (res.status < 200 || res.status >= 300) return { code: 1, stdout: '', stderr: `The runner refused: ${refusal(res.body, res.status)}. Nothing changed.` };
  const line = (res.body as { line?: unknown })?.line;
  return { code: 0, stdout: typeof line === 'string' ? line : loginModeChangeLine(mode!), stderr: '' };
}

// ── the runner's side (/api/logins on the socket) ───────────────────────────

/** POST /api/logins { mode }: set and save the mode. Running agents are untouched (R-19). */
export function applyLoginMode(body: unknown, deps: { setLoginMode: (mode: LoginMode) => void }): { status: number; body: Record<string, unknown> } {
  const mode = parseLoginMode((body as { mode?: unknown } | null)?.mode);
  if (!mode) return { status: 400, body: { error: `mode must be one of ${LOGIN_MODES.join(', ')}` } };
  deps.setLoginMode(mode);
  return { status: 200, body: { mode, line: loginModeChangeLine(mode) } };
}
