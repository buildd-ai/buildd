/**
 * Visual QA module: what core facts mean for a mission's `[surface audit]`.
 *
 * `task.left_mission` (PATCH /api/tasks/[id]): the task stops holding the old
 * mission's pending audit, and an audit it was the last thing holding is
 * woken (lib/mission-surface-audit-membership.ts). The claim gate already
 * ignores an audit's non-member dependency, so this keeps the stored list,
 * and every surface that reads it, honest.
 *
 * `pr.closed` (merged): the PR's rendered-surface files, with patches, are
 * recorded durably (lib/pr-surface-evidence.ts), so the surface-audit gate
 * never reads a merged PR's file list from GitHub while a page renders.
 *
 * `worker.reported` (a mission task's run ended): when it is a [surface
 * audit], the captures it uploaded have arrived, so the registered `verify:`
 * checks of every subject it reviews run again on them (the pinned tasks it
 * depends on and the mission's final verification;
 * lib/specs/registered-verification-store.ts). A check that found no capture
 * when its PR opened does not stay inconclusive forever.
 */
import { after } from 'next/server';
import { subscriber, type AnySubscriber } from '@/lib/core-events';

/** After the response when a request scope exists, inline otherwise. */
async function afterResponse(work: () => Promise<void>): Promise<void> {
  try {
    after(work);
  } catch {
    await work();
  }
}

export const surfaceAuditSubscribers: readonly AnySubscriber[] = [
  subscriber('visual-qa', 'task.left_mission', 'surface-audit-detach', async e => {
    const { onTaskLeftMission } = await import('@/lib/mission-surface-audit-membership');
    await onTaskLeftMission(e.missionId, e.taskId);
  }),
  subscriber('visual-qa', 'pr.closed', 'surface-evidence-on-merge', async e => {
    if (!e.merged || e.installationId == null || !e.repoFullName) return;
    const repo = { installationId: e.installationId, fullName: e.repoFullName };
    // A few GitHub reads: after the response when a request scope exists, inline otherwise.
    const record = () => import('@/lib/pr-surface-evidence')
      .then(m => m.persistMergedSurfaceEvidence(repo, e.prNumber, e.headSha))
      .catch(err => console.error(`[surface-evidence] PR #${e.prNumber} merged evidence not recorded:`, err));
    try {
      after(record);
    } catch {
      await record();
    }
  }),
  subscriber('visual-qa', 'worker.reported', 'registered-checks-on-captures', async e => {
    // Only a mission's audit supplies captures; the store reads the task to be sure.
    if (!e.missionId) return;
    await afterResponse(() => import('@/lib/specs/registered-verification-store')
      .then(m => m.rerunRegisteredVerificationForAudit(e.taskId))
      .catch(err => console.error(`[registered-verification] captures from ${e.taskId} not verified:`, err)));
  }),
];
