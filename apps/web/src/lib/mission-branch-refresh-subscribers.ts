import { after } from 'next/server';
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { refreshMissionBranchesForTrunkMerge } from '@/lib/mission-branch-refresh';

/** The hourly sweep backs up this best-effort webhook trigger. */
export const missionBranchRefreshSubscribers: readonly AnySubscriber[] = [
  subscriber('missions', 'pr.merged', 'refresh-mission-integration-branches', async e => {
    const baseRef = e.delivery?.baseRef;
    if (!baseRef) return;
    const refresh = () => refreshMissionBranchesForTrunkMerge({ repoFullName: e.repoFullName, baseRef })
      .catch(err => console.error(`[webhook] mission branch refresh failed for ${e.repoFullName}@${baseRef}:`, err));
    try {
      after(refresh);
    } catch {
      await refresh();
    }
  }),
];
