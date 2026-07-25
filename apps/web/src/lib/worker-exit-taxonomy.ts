export type WorkerExitCause =
  | 'code_failure'
  | 'budget_limited'
  | 'infra_failure'
  | 'reassigned'
  | 'condition_unmet'
  | 'sandbox_mount_gap';

export function classifyReportedFailure(input: {
  budgetLimited: boolean;
  sandboxMountGap: boolean;
}): WorkerExitCause {
  if (input.budgetLimited) return 'budget_limited';
  if (input.sandboxMountGap) return 'sandbox_mount_gap';
  return 'code_failure';
}

export function consumesRetryAttempt(exitCause: WorkerExitCause | null | undefined): boolean {
  return exitCause !== 'budget_limited'
    && exitCause !== 'infra_failure'
    && exitCause !== 'sandbox_mount_gap'
    && exitCause !== 'condition_unmet';
}
