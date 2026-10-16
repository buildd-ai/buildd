/**
 * The missions module's half of the kernel's mission epochs
 * (docs/specs/workflow-kernel-library.md §6): what the epoch authority
 * (lib/workflow/delivery-epochs.ts, core) reads about a mission and cannot
 * import, filled into the composition root's `MISSION_EPOCH_HOOKS` slot.
 */
import type { MissionEpochHooks } from '@/lib/workflow/delivery-ship';
import { evaluateMissionWorkState, findMissionPrOwner } from '@/lib/mission-pr';
import { resolveMissionRepoWorkspaceId } from '@/lib/mission-repo-workspace';

export const missionEpochHooks: MissionEpochHooks = {
  async workOf(missionId) {
    const w = await evaluateMissionWorkState(missionId);
    return { unfinishedTasks: w.unfinishedTaskCount, openTaskPrs: w.unmergedPrCount };
  },
  async legacyPrOf(missionId) {
    const owner = await findMissionPrOwner(missionId);
    if (!owner) return null;
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(owner.prUrl ?? '');
    return {
      prNumber: owner.prNumber ?? (m ? Number(m[2]) : null),
      repoFullName: m?.[1] ?? null,
      ownerTaskId: owner.taskId,
      state: owner.state,
      mergedAt: owner.mergedAt ? owner.mergedAt.toISOString() : null,
    };
  },
  async repoWorkspaceOf(missionId, missionWorkspaceId) {
    return (await resolveMissionRepoWorkspaceId({ missionId, missionWorkspaceId })).workspaceId;
  },
};
