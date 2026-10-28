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

import { activeRunnerHold } from './runner-hold';

/** 0 is a real setting: the runner claims nothing (spec 97b1bd0b R-18). Pause is a separate state. */
export const MIN_RUNNER_SLOTS = 0;
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

/** One side's change of a value: the value, where it came from, who and when (epoch ms). */
interface Desired { origin: SlotsOrigin; setBy: string | null; setAt: number }

/**
 * The later change wins, whichever side made it. A tie goes to the dashboard,
 * so a machine that never recorded a change time (0) never overrides a person.
 */
function reconcile<V, D extends Desired>(
  desired: D | null,
  reported: V | null,
  reportedChangedAt: number | null,
  now: number,
  valueOf: (d: D) => V,
  fromMachine: (v: V, setAt: number) => D,
): { desired: D | null; write: boolean; deliver: D | null } {
  const changedAt = reportedChangedAt && reportedChangedAt > 0 ? reportedChangedAt : 0;
  if (reported === null) {
    // An older runner says nothing; a dashboard value still cannot reach it.
    return { desired, write: false, deliver: null };
  }
  if (!desired) return { desired: fromMachine(reported, changedAt || now), write: true, deliver: null };
  if (valueOf(desired) === reported) return { desired, write: false, deliver: null };
  if (changedAt > desired.setAt) return { desired: fromMachine(reported, changedAt), write: true, deliver: null };
  return { desired, write: false, deliver: desired };
}

export function reconcileDesiredSlots(input: SlotsReconcileInput): SlotsReconcileResult {
  return reconcile<number, DesiredSlots>(
    input.desired, input.reported, input.reportedChangedAt, input.now,
    d => d.slots,
    (slots, setAt) => ({ slots, origin: 'machine', setBy: null, setAt }),
  );
}

// ── Pause (spec 97b1bd0b R-18) ──────────────────────────────────────────────
//
// Paused: take no new work, let running work finish. On the runner it is the
// same state as `buildd hold` (runner-hold.ts): a separate state from slots,
// so Resume leaves the slots as they were. The server keeps a desired value
// per runner the same way as slots, and the same rule decides.

export interface DesiredPause {
  paused: boolean;
  origin: SlotsOrigin;
  setBy: string | null;
  setAt: number;
}

export interface PauseReconcileInput {
  desired: DesiredPause | null;
  /** Whether the runner says it is held; null when it says nothing (older runner). */
  reported: boolean | null;
  /** Epoch ms of the runner's own last hold or resume; null/0 when never recorded. */
  reportedChangedAt: number | null;
  now: number;
}

export function reconcileDesiredPause(input: PauseReconcileInput): { desired: DesiredPause | null; write: boolean; deliver: DesiredPause | null } {
  return reconcile<boolean, DesiredPause>(
    input.desired, input.reported, input.reportedChangedAt, input.now,
    d => d.paused,
    (paused, setAt) => ({ paused, origin: 'machine', setBy: null, setAt }),
  );
}

/**
 * Whether a heartbeat environment says the runner is held: true or false when
 * it carries a `hold` key (a runner sends null when not held), null when it
 * carries none.
 */
export function reportedRunnerPause(environment: unknown, now: number = Date.now()): boolean | null {
  if (!environment || typeof environment !== 'object' || !('hold' in environment)) return null;
  return activeRunnerHold(environment, now) !== null;
}

/** "paused on buildd.dev by Max, 10:44" / "resumed on this machine, 10:44". */
export function describePauseOrigin(d: Pick<DesiredPause, 'paused' | 'origin' | 'setBy' | 'setAt'>, clock: (ms: number) => string): string {
  const verb = d.paused ? 'paused' : 'resumed';
  const at = clock(d.setAt);
  return d.origin === 'dashboard'
    ? `${verb} on buildd.dev${d.setBy ? ` by ${d.setBy}` : ''}, ${at}`
    : `${verb} on this machine, ${at}`;
}

/** "set on buildd.dev by Max, 14:02" / "set on this machine, 14:02": the one line both sides print. */
export function describeSlotsOrigin(d: Pick<DesiredSlots, 'origin' | 'setBy' | 'setAt'>, clock: (ms: number) => string): string {
  const at = clock(d.setAt);
  return d.origin === 'dashboard'
    ? `set on buildd.dev${d.setBy ? ` by ${d.setBy}` : ''}, ${at}`
    : `set on this machine, ${at}`;
}
