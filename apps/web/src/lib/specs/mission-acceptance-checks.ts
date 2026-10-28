import { dispatchCriterionChecks, settleFinishedCheckRuns } from './criterion-checks';
import { resolveMissionCheckTarget } from './mission-outcome';

export type FinalAcceptanceChecks = Awaited<ReturnType<typeof dispatchCriterionChecks>> & {
  /** Finished check runs of this mission whose verdict had never been recorded, recorded now. */
  settled: number;
};

/**
 * Runner-owned checks, independent of the final verifier's written judgement:
 * the selected revision's `check:` commands, and its registered `verify:`
 * checks through the same coordinator an explicit request uses.
 *
 * What already finished is settled before anything new is filed: a check run
 * whose runner report never became a verdict row (one lost event) would
 * otherwise leave the criterion unverified at a target nothing re-checks
 * (df808193: twenty of twenty-one runs at the integrated target ended that way).
 */
export async function runFinalAcceptanceChecks(taskId: string, missionId: string, opts: { rerun?: boolean } = {}): Promise<FinalAcceptanceChecks | null> {
  const settled = await settleFinishedCheckRuns(missionId).catch((err) => {
    console.error(`[spec-checks] settling finished check runs of mission ${missionId} failed:`, err instanceof Error ? err.message : err);
    return { settled: 0, attempted: 0 };
  });
  const target = await resolveMissionCheckTarget(missionId);
  if (!target) return { dispatched: 0, reason: 'no integrated target to check', settled: settled.settled };
  const filed = await dispatchCriterionChecks({ taskId, headSha: target.headSha, headBranch: target.branch, ...(opts.rerun ? { rerun: true } : {}) });
  const result = { ...filed, settled: settled.settled };
  try {
    const { dispatchRegisteredVerification } = await import('./registered-verification');
    const { registeredVerificationDeps } = await import('./registered-verification-store');
    const r = await dispatchRegisteredVerification({ taskId, headSha: target.headSha }, registeredVerificationDeps);
    if (r.reason) console.warn(`[registered-verification] final verification ${taskId}: ${r.reason}`);
  } catch (err) {
    // Registered checks never stop the command checks or the final verifier; their absence reads as unverified.
    console.error(`[registered-verification] final verification ${taskId} failed:`, err instanceof Error ? err.message : err);
  }
  return result;
}
