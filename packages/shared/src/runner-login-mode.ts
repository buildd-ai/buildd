/**
 * How a runner's own logins share its slots (Living Spec 34a48877, "Which
 * login takes which work", R-14 to R-19). The runner owns the choice, like its
 * slots: set on the machine (`b` in top, `buildd logins <mode>`), reported in
 * the heartbeat, and sent on every claim with how many of its agents run on
 * each backend. The claim route reads it to pick the backend for work no task,
 * role, mission or workspace ties to one.
 */

export type LoginMode = 'balanced' | 'claude-first' | 'codex-first';
export type LoginBackend = 'claude' | 'codex';

export const LOGIN_MODES: readonly LoginMode[] = ['balanced', 'claude-first', 'codex-first'];
export const DEFAULT_LOGIN_MODE: LoginMode = 'balanced';

export function parseLoginMode(raw: unknown): LoginMode | null {
  return typeof raw === 'string' && (LOGIN_MODES as readonly string[]).includes(raw) ? (raw as LoginMode) : null;
}

/** `b` in top: balanced → claude-first → codex-first → balanced. */
export function nextLoginMode(mode: LoginMode): LoginMode {
  return LOGIN_MODES[(LOGIN_MODES.indexOf(mode) + 1) % LOGIN_MODES.length];
}

/**
 * How many of the runner's slots each backend may use. Balanced gives Codex a
 * third (at least 1) and Claude the rest (at least 1); a first-mode lets
 * either take every slot, since the other only takes overflow.
 */
export function backendShares(mode: LoginMode, slots: number): Record<LoginBackend, number> {
  const n = Math.max(1, Math.floor(slots));
  if (mode !== 'balanced') return { claude: n, codex: n };
  const codex = Math.max(1, Math.ceil(n / 3));
  return { claude: Math.max(1, n - codex), codex };
}

/** What the runner sends on a claim: its mode, its slots and its live agents per backend. */
export interface RunnerLoginUse {
  mode: LoginMode;
  slots: number;
  running: Record<LoginBackend, number>;
}

/** Parse a claim body's `loginUse`; null for an older runner that sends none (or a garbled one). */
export function parseRunnerLoginUse(raw: unknown): RunnerLoginUse | null {
  const r = raw as { mode?: unknown; slots?: unknown; running?: { claude?: unknown; codex?: unknown } } | null;
  const mode = parseLoginMode(r?.mode);
  if (!mode) return null;
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
  const slots = typeof r?.slots === 'number' && Number.isInteger(r.slots) && r.slots >= 1 ? r.slots : 1;
  return { mode, slots, running: { claude: count(r?.running?.claude), codex: count(r?.running?.codex) } };
}

export interface LoginBackendInput {
  mode: LoginMode;
  slots: number;
  /** This runner's agents already running (or claimed in this batch) per backend. */
  running: Record<LoginBackend, number>;
  /** The backend's access reaches this runner, its provider is enabled, and it is not at a limit. */
  claudeUsable: boolean;
  codexUsable: boolean;
}

/**
 * The backend the runner's mode picks for one task tied to no backend (R-15).
 * When only one login can take work it takes it, whatever the mode; null when
 * neither can. Balanced picks the login whose share is least full, Claude on a
 * tie, so a short batch spreads instead of filling one login first.
 */
export function pickLoginBackend(input: LoginBackendInput): LoginBackend | null {
  const { mode, claudeUsable, codexUsable } = input;
  if (!claudeUsable && !codexUsable) return null;
  if (!codexUsable) return 'claude';
  if (!claudeUsable) return 'codex';
  if (mode === 'claude-first') return 'claude';
  if (mode === 'codex-first') return 'codex';
  const share = backendShares(mode, input.slots);
  const fill = (b: LoginBackend) => input.running[b] / share[b];
  return fill('codex') < fill('claude') ? 'codex' : 'claude';
}

/** Words for the routing reason (R-18): "routed to Codex by this runner's balanced mode". */
export function loginModeRoutingWords(mode: LoginMode, backend: LoginBackend): string {
  return `routed to ${backend === 'codex' ? 'Codex' : 'Claude'} by this runner's ${mode} mode`;
}
