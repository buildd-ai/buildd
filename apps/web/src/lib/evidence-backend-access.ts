/**
 * Which evidence backends a caller may see. A team-default backend (no
 * workspace) is visible to the whole team; a workspace-scoped one only to
 * callers who can reach that workspace, so a restricted workspace's bucket and
 * endpoint names do not leak to a team member with no access to it.
 *
 * An API account reaches a workspace per `verifyAccountWorkspaceAccess`
 * (restricted = linked accounts only); a session user per team membership
 * (`verifyWorkspaceAccess`).
 */
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import type { ExperimentViewer } from '@/lib/experiment-access';

export async function filterReachableEvidenceBackends<T extends { workspaceId: string | null }>(
  viewer: ExperimentViewer,
  rows: T[],
): Promise<T[]> {
  const workspaceIds = [...new Set(rows.map((r) => r.workspaceId).filter((id): id is string => !!id))];
  const reach = new Map<string, boolean>();
  await Promise.all(workspaceIds.map(async (id) => {
    const ok = viewer.accountId
      ? await verifyAccountWorkspaceAccess(viewer.accountId, id)
      : viewer.userId
        ? (await verifyWorkspaceAccess(viewer.userId, id)) !== null
        : false;
    reach.set(id, ok);
  }));
  return rows.filter((r) => !r.workspaceId || reach.get(r.workspaceId) === true);
}
