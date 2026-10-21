import { dispatchCriterionChecks } from './criterion-checks';
import { resolveMissionCheckTarget } from './mission-outcome';

/** Runner-owned checks, independent of the final verifier's written judgement. */
export async function runFinalAcceptanceChecks(taskId: string, missionId: string): Promise<void> {
  const target = await resolveMissionCheckTarget(missionId);
  if (!target) return;
  await dispatchCriterionChecks({ taskId, headSha: target.headSha, headBranch: target.branch });
}
