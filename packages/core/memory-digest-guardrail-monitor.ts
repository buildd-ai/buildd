/**
 * Standing post-ship guardrail monitor for the workspace-memory-digest
 * experiment (`docs/design/workspace-memory-digest-arm.md`).
 *
 * The experiment shipped `task_scoped` on 2026-09-18 with the failure-rate
 * guardrail recorded as an accepted caveat, not a blocker: the terminal
 * readout (`memory-digest-readout:memory-digest-v4`) measured 18.8% (`full`)
 * vs 24.1% (`task_scoped`), a risk difference of +5.2pp whose 95% interval
 * [-0.9, +11.3] crossed zero. The decision was "ship it and watch the failure
 * rate" — and then the readout cron that could have watched it was correctly
 * retired with the experiment (PR #2466), which left the accepted arm with no
 * owner. This module is the owner.
 *
 * It does NOT re-run the experiment. There is no control arm any more — every
 * row since the flip carries `arm: 'task_scoped', propensity: 1, fraction: 1`
 * (see the design doc's "Releasing pin guards" section) — so a fresh
 * task_scoped-vs-full comparison is not possible and would not mean anything
 * if it were. Instead this asks the only question a single-arm fleet can
 * still answer: **is the shipped arm's failure rate credibly worse now than
 * it was measured to be at ship time?** "Credibly" is load-bearing — the
 * comparison is Agresti–Caffo risk difference against the ship-time cohort,
 * the same interval the terminal readout itself used for the guardrail, so a
 * noisy week does not page anyone and a real regression does not hide in
 * n=12.
 *
 * ── Failure definition ───────────────────────────────────────────────────
 * `FAILED_STATUSES`, imported rather than redefined, so this can never
 * silently diverge from what the terminal readout counted as a catastrophe.
 *
 * ── The no-terminal-signal caveat ────────────────────────────────────────
 * A prior audit (raw runner logs, not this rail) reported that roughly a
 * quarter of started sessions emit no terminal signal at all, and warned that
 * every failure rate computed against an incomplete denominator carries
 * unknown bias. Checked directly against this rail — `workers` rows joined to
 * `worker_prompt_composition_events` by `taskId`, which is what this monitor
 * and the terminal readout both read — that gap did not reproduce: every
 * shipped-arm prompt build in the verification window had a matching worker
 * row, and a fleet-wide scan found zero workers stuck in `running` for more
 * than six hours over the prior three weeks. The audit's ~25% figure most
 * likely came from raw log parsing (a source this repo's own tooling
 * documents as unreliable — see the delivery-forensics skill), not from a
 * hole in the DB rail this monitor reads. `sessionless` below still reports
 * the count structurally rather than assuming the gap stays at zero forever:
 * a shipped-arm task with composition rows but no matching session is
 * unmeasured, not passing, and a monitor that quietly treated it as a pass
 * would be exactly the kind of signal-that-cannot-fail this repo has a
 * documented history of shipping.
 */

import { riskDiff, FAILED_STATUSES, DEFAULT_BACKEND, type CompositionRow, type SessionRow, type Interval } from './memory-digest-readout';

/**
 * The task_scoped arm's own failure rate at ship time (post-boundary cohort,
 * backend claude), read from the terminal artifact
 * `memory-digest-readout:memory-digest-v4` (generated 2026-09-18T11:00:00Z).
 * This is the accepted baseline: the monitor never re-litigates whether 83/345
 * was okay to ship (that decision is recorded in the design doc), it watches
 * for the shipped arm drifting CREDIBLY WORSE than this number.
 */
export const SHIP_BASELINE_TASK_SCOPED_FAILURES = 83;
export const SHIP_BASELINE_TASK_SCOPED_N = 345;

/** Rolling window the monitor evaluates. 7 days: long enough to smooth day-of-week task mix, short enough that a real regression is caught inside a week. */
export const GUARDRAIL_WINDOW_DAYS = 7;
const GUARDRAIL_WINDOW_MS = GUARDRAIL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface GuardrailMonitorInput {
  /** Prompt-composition rows for any window wide enough to cover the evaluation window — the function does its own filtering. */
  composition: readonly CompositionRow[];
  /** Worker sessions for tasks referenced by `composition`. */
  sessions: readonly SessionRow[];
  now: Date;
  backend?: string;
  windowMs?: number;
}

export interface GuardrailVerdict {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  backend: string;
  /** Shipped-arm tasks in the window with at least one session (a measured outcome). */
  n: number;
  failed: number;
  rate: number | null;
  /** Shipped-arm tasks in the window with composition rows but no matching session — unmeasured, never counted as a pass. */
  sessionless: number;
  baseline: { failures: number; n: number; rate: number };
  /** Rolling risk difference (window − ship baseline), Agresti–Caffo, 95%. */
  diff: Interval;
  /** True only when the interval excludes zero, i.e. the window is credibly worse than the ship baseline, not just noisier. */
  alarm: boolean;
  reason: string;
}

/**
 * Evaluate the guardrail over the trailing window ending at `now`.
 *
 * Pure — no IO, deterministic on its inputs, same shape as
 * `memory-digest-readout.ts`'s arithmetic layer for the same reason: a
 * detector whose predicate lives only in a query is untestable without a live
 * cohort.
 */
export function evaluateMemoryDigestGuardrail(input: GuardrailMonitorInput): GuardrailVerdict {
  const backend = input.backend ?? DEFAULT_BACKEND;
  const windowMs = input.windowMs ?? GUARDRAIL_WINDOW_MS;
  const windowStart = new Date(input.now.getTime() - windowMs);

  // Shipped-arm rows only: arm === 'task_scoped' AND propensity === 1 excludes
  // the pre-flip randomised cohort (propensity 0.5 in this fleet's history) —
  // that cohort is the ship-time baseline, not part of the rolling window.
  // Backend is excluded (not imputed) on a NULL, matching the terminal
  // readout's segmentation discipline: promptBytes/memoryShare/failure
  // context all mean something different on another backend.
  const windowTaskIds = new Set<string>();
  for (const row of input.composition) {
    if (!row.taskId) continue;
    if (row.arm !== 'task_scoped') continue;
    if (row.propensity !== 1) continue;
    if (row.backend !== backend) continue;
    if (row.ts.getTime() < windowStart.getTime() || row.ts.getTime() > input.now.getTime()) continue;
    windowTaskIds.add(row.taskId);
  }

  const sessionsByTask = new Map<string, SessionRow[]>();
  for (const s of input.sessions) {
    if (!s.taskId || !windowTaskIds.has(s.taskId)) continue;
    const list = sessionsByTask.get(s.taskId);
    if (list) list.push(s);
    else sessionsByTask.set(s.taskId, [s]);
  }

  let failed = 0;
  let measured = 0;
  let sessionless = 0;
  for (const taskId of windowTaskIds) {
    const sessions = sessionsByTask.get(taskId);
    if (!sessions || sessions.length === 0) {
      sessionless++;
      continue;
    }
    measured++;
    if (sessions.some(s => FAILED_STATUSES.has(s.status))) failed++;
  }

  const rate = measured > 0 ? failed / measured : null;
  const baselineRate = SHIP_BASELINE_TASK_SCOPED_FAILURES / SHIP_BASELINE_TASK_SCOPED_N;
  const diff = riskDiff(failed, measured, SHIP_BASELINE_TASK_SCOPED_FAILURES, SHIP_BASELINE_TASK_SCOPED_N);

  const alarm = diff.ciLow !== null && diff.ciLow > 0;
  const reason = alarm
    ? `rolling failure rate ${(rate! * 100).toFixed(1)}% (${failed}/${measured}) is credibly worse than the ` +
      `${(baselineRate * 100).toFixed(1)}% (${SHIP_BASELINE_TASK_SCOPED_FAILURES}/${SHIP_BASELINE_TASK_SCOPED_N}) ` +
      `accepted at ship — risk diff ${(diff.value! * 100).toFixed(1)}pp, 95% CI excludes zero ` +
      `[${(diff.ciLow! * 100).toFixed(1)}, ${(diff.ciHigh! * 100).toFixed(1)}]`
    : measured === 0
      ? 'no shipped-arm sessions with a measured outcome in the window — nothing to evaluate'
      : `rolling failure rate ${(rate! * 100).toFixed(1)}% (${failed}/${measured}) is within noise of the ` +
        `${(baselineRate * 100).toFixed(1)}% ship baseline`;

  return {
    windowDays: Math.round(windowMs / (24 * 60 * 60 * 1000)),
    windowStart: windowStart.toISOString(),
    windowEnd: input.now.toISOString(),
    backend,
    n: measured,
    failed,
    rate,
    sessionless,
    baseline: {
      failures: SHIP_BASELINE_TASK_SCOPED_FAILURES,
      n: SHIP_BASELINE_TASK_SCOPED_N,
      rate: baselineRate,
    },
    diff,
    alarm,
    reason,
  };
}
