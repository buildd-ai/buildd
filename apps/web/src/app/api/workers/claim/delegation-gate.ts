import { describeDelegationGaps, type DelegationGap } from '@buildd/core/token-delegation';
import { preflightTaskDelegation } from '@/lib/task-delegation-checks';

/**
 * Claim pre-flight for cross-workspace work (packages/core/token-delegation.ts).
 *
 * A task that will file tasks in, or read analytics of, another workspace
 * needs its token to carry that reach. Before this gate the run started anyway
 * and found the wall mid-task: the filing was refused, the agent parked on a
 * question, the run ended, and its continuation asked the same question again.
 *
 * So a task is held here, before any agent turn, when its declared filing
 * targets are not granted, or a grant names a workspace the token minted from
 * this claiming account could not use. Not forceable: forcing would only start
 * the agent that then discovers the gap. A person fixes it by granting the
 * delegation (update_task, before claim) or by claiming from an account that
 * reaches the target.
 */
export interface DelegationGateResult {
  gaps: DelegationGap[];
  detail: string;
}

export async function checkDelegationGate(
  task: { id: string; workspaceId: string; scheduleId?: string | null; delegation?: unknown; context?: unknown },
  account: Parameters<typeof preflightTaskDelegation>[1],
): Promise<DelegationGateResult | null> {
  const gaps = await preflightTaskDelegation(task, account);
  if (!gaps.length) return null;
  return { gaps, detail: describeDelegationGaps(gaps) };
}
