import {
  delegationGrantCovering, describeDelegationGaps, readScheduleDelegation, type DelegationGap, type ScheduleDelegationGrant,
} from '@buildd/core/token-delegation';
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
 * targets or reads (filingTargets, readsFrom) are not granted, or a grant
 * names a workspace the token minted from this claiming account could not
 * use. Not forceable: forcing would only start the agent that then discovers
 * the gap. A person fixes it with the one write `grant` spells out: the
 * task page shows the held task's uncovered needs with a Grant access action
 * (tasks/[id]/DelegationGrantCard.tsx, from delegationGrantOffer), the same
 * person-only update_task { delegation } write. Or a runner account that
 * reaches the target claims it.
 */
export interface DelegationGateResult {
  gaps: DelegationGap[];
  /** The task delegation that covers every missing grant; null when no grant would help. */
  grant: { grants: ScheduleDelegationGrant[] } | null;
  detail: string;
}

export async function checkDelegationGate(
  task: { id: string; workspaceId: string; scheduleId?: string | null; delegation?: unknown; context?: unknown },
  account: Parameters<typeof preflightTaskDelegation>[1],
): Promise<DelegationGateResult | null> {
  const gaps = await preflightTaskDelegation(task, account);
  if (!gaps.length) return null;
  const grant = delegationGrantCovering(gaps, readScheduleDelegation(task.delegation));
  const action = grant
    ? ` One action grants it, by a person who reaches each workspace: Grant access on the task page (/app/tasks/${task.id}), or update_task { taskId: "${task.id}", delegation: ${JSON.stringify(grant)} }.`
    : '';
  return { gaps, grant, detail: `${describeDelegationGaps(gaps)}.${action}` };
}
