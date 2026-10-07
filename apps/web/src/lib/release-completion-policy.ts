/**
 * Releases' release-slot policy (lib/completion-policy.ts). A completed task
 * is not done until its release lands: `executeRelease` decides, and the
 * worker PATCH applies the verdict (flip to failed, or hold for CI).
 *
 * `settled`: the mission-level release (on_mission_complete) fires once every
 * task in the mission is terminal. Fire-and-forget; the helper checks the
 * trigger policy and dedupes on missions.releasedAt.
 */
import type { ReleasePolicy } from '@/lib/completion-policy';
import { executeRelease } from '@/lib/release-executor';
import { fireMissionReleaseIfComplete } from '@/lib/mission-release';

export const releasePolicy: ReleasePolicy = {
  async evaluate({ taskId, workerId, workspaceId }) {
    const r = await executeRelease({ taskId, workerId, workspaceId });
    if (r.status === 'failed') {
      return { kind: 'fail', record: r, summary: r.message, reason: r.error ?? r.message, prUrl: r.releasePrUrl };
    }
    if (r.status === 'pending_ci') {
      return { kind: 'hold', until: 'ci', record: r, summary: r.message, prNumber: r.releasePrNumber, prUrl: r.releasePrUrl };
    }
    return { kind: 'pass', record: r, summary: r.message };
  },
  settled({ workspaceId, missionId, taskId, workerId }) {
    if (!missionId) return;
    fireMissionReleaseIfComplete(workspaceId, missionId, taskId, workerId)
      .catch((err) => console.error(`[Worker ${workerId}] Mission release check failed:`, err));
  },
};
