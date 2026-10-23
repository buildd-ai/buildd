/**
 * A runner's slots have one source of truth: the last change wins, whichever
 * side made it (spec "Runner on your terminal", dashboard-set slots).
 *
 * The server keeps a desired value per runner (who set it, when, from where),
 * separate from the value the runner reports. The runner keeps the time of its
 * own last change in config.json and sends it with every heartbeat. This
 * function decides, for one heartbeat, whether the machine's value becomes the
 * desired one or the desired one is handed back to the runner.
 */

export const MIN_RUNNER_SLOTS = 1;
/** The same bound the runner's `buildd slots` and the heartbeat accept. */
export const MAX_RUNNER_SLOTS = 50;

export type SlotsOrigin = 'dashboard' | 'machine';

export interface DesiredSlots {
  slots: number;
  origin: SlotsOrigin;
  /** Display name of the person who set it from the dashboard; null for a machine change. */
  setBy: string | null;
  /** Epoch ms of the change. */
  setAt: number;
}

/** A whole number of slots in range, or null. */
export function parseRunnerSlots(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_RUNNER_SLOTS && raw <= MAX_RUNNER_SLOTS ? raw : null;
}

export interface SlotsReconcileInput {
  desired: DesiredSlots | null;
  /** The runner's slots as it reports them; null when it did not report (older runner). */
  reported: number | null;
  /** Epoch ms of the runner's own last change; null/0 when it never recorded one. */
  reportedChangedAt: number | null;
  /** Server time, used when a first report carries no change time. */
  now: number;
}

export interface SlotsReconcileResult {
  /** What to store as the desired value (the input's when nothing changes). */
  desired: DesiredSlots | null;
  /** True when `desired` differs from the input and must be written. */
  write: boolean;
  /** Set when the runner must apply this value: a dashboard change it has not taken yet. */
  deliver: DesiredSlots | null;
}

export function reconcileDesiredSlots(input: SlotsReconcileInput): SlotsReconcileResult {
  const { desired, reported, reportedChangedAt, now } = input;
  const changedAt = reportedChangedAt && reportedChangedAt > 0 ? reportedChangedAt : 0;

  if (reported === null) {
    // An older runner says nothing about its slots; a dashboard value still cannot reach it.
    return { desired, write: false, deliver: null };
  }
  if (!desired) {
    return { desired: { slots: reported, origin: 'machine', setBy: null, setAt: changedAt || now }, write: true, deliver: null };
  }
  if (desired.slots === reported) {
    return { desired, write: false, deliver: null };
  }
  // They differ: the later change wins. A tie goes to the dashboard, so a
  // machine that never recorded a change time (0) never overrides a person.
  if (changedAt > desired.setAt) {
    return { desired: { slots: reported, origin: 'machine', setBy: null, setAt: changedAt }, write: true, deliver: null };
  }
  return { desired, write: false, deliver: desired };
}

/** "set on buildd.dev by Max, 14:02" / "set on this machine, 14:02": the one line both sides print. */
export function describeSlotsOrigin(d: Pick<DesiredSlots, 'origin' | 'setBy' | 'setAt'>, clock: (ms: number) => string): string {
  const at = clock(d.setAt);
  return d.origin === 'dashboard'
    ? `set on buildd.dev${d.setBy ? ` by ${d.setBy}` : ''}, ${at}`
    : `set on this machine, ${at}`;
}
