export type WorkerExitCause =
  | 'code_failure'
  | 'budget_limited'
  | 'infra_failure'
  | 'never_started'
  | 'silent_start'
  | 'reassigned'
  | 'condition_unmet'
  | 'sandbox_mount_gap';

/**
 * Failure strings that mean "the coordination server told the runner to stop",
 * not "the agent's work failed".
 *
 * `Terminated by server` is the runner's fallback text when a PATCH came back
 * with `abort: true` and no stated reason — historically produced by a
 * lost-update miss on the worker-row CAS, which killed healthy sessions ~1s
 * after start. Such a report is an infra event: it must never be filed as a
 * code failure and must never consume a retry attempt.
 */
const CONCURRENCY_CONFLICT_PATTERNS = [
  /terminated by server/i,
  /worker state changed concurrently/i,
];

export function isConcurrencyConflictError(error: string | null | undefined): boolean {
  if (!error) return false;
  return CONCURRENCY_CONFLICT_PATTERNS.some(p => p.test(error));
}

/** Error text for a worker row that the claim route minted but no runner ever started. */
export const NEVER_STARTED_ERROR =
  'Worker was never started by a runner (claimed but no session began) — cleaned up as a bookkeeping artifact, not a task failure';

/** Error text for a session that reached started_at but streamed nothing at all. */
export const SILENT_START_ERROR =
  'Worker started but produced no output (0 assistant turns, $0 spend) — the agent session died before its first real turn; check the runner log for this worker id';

/** Error text for the generic staleness kill (a worker that did real work, then went quiet). */
export const STALE_EXPIRED_ERROR = 'Stale worker expired (no update for 15+ minutes)';

/**
 * A session with at most this many turns and zero spend never really produced
 * anything: turn 1–2 are the SDK init/system exchange, so anything at or below
 * this with $0 cost means no assistant output was ever streamed.
 */
export const SILENT_START_MAX_TURNS = 2;

export function classifyReportedFailure(input: {
  budgetLimited: boolean;
  sandboxMountGap: boolean;
  steeringDelivery?: boolean;
  concurrencyConflict?: boolean;
}): WorkerExitCause {
  if (input.budgetLimited) return 'budget_limited';
  if (input.sandboxMountGap) return 'sandbox_mount_gap';
  // Steering-delivery crashes are infra failures — the CLI rejected a malformed
  // invocation, not a code defect. Must not consume a retry attempt.
  if (input.steeringDelivery) return 'infra_failure';
  // Server-side concurrency conflicts are infra failures for the same reason:
  // the session was killed by coordination bookkeeping, not by the work.
  if (input.concurrencyConflict) return 'infra_failure';
  return 'code_failure';
}

/**
 * Classify a worker the reaper is about to kill.
 *
 * Before this existed everything the reaper touched was booked as
 * `infra_failure` with "Stale worker expired (no update for 15+ minutes)".
 * That collapsed three very different situations into one undiagnosable
 * bucket (2026-08-28: 31 of 127 weekly failures were $0/≤2-turn rows):
 *
 *   never_started — the row was created at claim but no runner ever started it
 *                   (over-claim: the runner started worker 1 of N and threw
 *                   before the rest). Not an infra failure, a bookkeeping
 *                   artifact; must never consume the task's retry budget.
 *   silent_start  — started_at is set but the session streamed nothing at all.
 *                   Points at the runner/SDK stream, not the task.
 *   infra_failure — the worker did real work and then went offline.
 */
export function classifyStaleExit(worker: {
  startedAt?: Date | string | null;
  turns?: number | null;
  costUsd?: string | number | null;
}): { exitCause: WorkerExitCause; error: string } {
  if (!worker.startedAt) {
    return { exitCause: 'never_started', error: NEVER_STARTED_ERROR };
  }
  const turns = worker.turns ?? 0;
  const rawCost = worker.costUsd;
  const cost = typeof rawCost === 'string' ? parseFloat(rawCost) : (rawCost ?? 0);
  const spent = Number.isFinite(cost) ? cost : 0;
  if (turns <= SILENT_START_MAX_TURNS && spent <= 0) {
    return { exitCause: 'silent_start', error: SILENT_START_ERROR };
  }
  return { exitCause: 'infra_failure', error: STALE_EXPIRED_ERROR };
}

export function consumesRetryAttempt(exitCause: WorkerExitCause | null | undefined): boolean {
  return exitCause !== 'budget_limited'
    && exitCause !== 'infra_failure'
    && exitCause !== 'sandbox_mount_gap'
    && exitCause !== 'condition_unmet'
    // A row no runner ever started, and a session that streamed nothing, say
    // nothing about the task — charging them would burn the retry budget of a
    // task that was never actually attempted.
    && exitCause !== 'never_started'
    && exitCause !== 'silent_start';
}
