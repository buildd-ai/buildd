export type WorkerExitCause =
  | 'code_failure'
  | 'budget_limited'
  | 'infra_failure'
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

export function consumesRetryAttempt(exitCause: WorkerExitCause | null | undefined): boolean {
  return exitCause !== 'budget_limited'
    && exitCause !== 'infra_failure'
    && exitCause !== 'sandbox_mount_gap'
    && exitCause !== 'condition_unmet';
}
