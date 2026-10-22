import { dispatchCriterionChecks } from './criterion-checks';
import { resolveMissionCheckTarget } from './mission-outcome';

/**
 * Runner-owned checks, independent of the final verifier's written judgement:
 * the selected revision's `check:` commands, and its registered `verify:`
 * checks through the same coordinator an explicit request uses.
 */
export async function runFinalAcceptanceChecks(taskId: string, missionId: string): Promise<void> {
  const target = await resolveMissionCheckTarget(missionId);
  if (!target) return;
  await dispatchCriterionChecks({ taskId, headSha: target.headSha, headBranch: target.branch });
  try {
    const { dispatchRegisteredVerification } = await import('./registered-verification');
    const r = await dispatchRegisteredVerification({ taskId, headSha: target.headSha });
    if (r.reason) console.warn(`[registered-verification] final verification ${taskId}: ${r.reason}`);
  } catch (err) {
    // Registered checks never stop the command checks or the final verifier; their absence reads as unverified.
    console.error(`[registered-verification] final verification ${taskId} failed:`, err instanceof Error ? err.message : err);
  }
}
