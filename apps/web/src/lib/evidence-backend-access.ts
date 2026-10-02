/**
 * Which evidence backends a caller may see. A team-default backend (no
 * workspace) is visible to the whole team; a workspace-scoped one only to
 * callers who can reach that workspace, so a restricted workspace's bucket and
 * endpoint names do not leak to a team member with no access to it.
 *
 * An API account reaches a workspace per `verifyAccountWorkspaceAccess`
 * (restricted = linked accounts only); a session user per team membership
 * (`verifyWorkspaceAccess`). A caller carrying both (an OAuth JWT bearer
 * resolves to an account and a user) is decided by the account, as
 * GET /api/tasks/[id] and the evidence read routes (GET /api/tasks/[id]/evidence,
 * GET /api/evidence) decide it.
 */
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import type { ExperimentViewer } from '@/lib/experiment-access';

type Reacher = { accountId?: string | null; userId?: string | null };

export async function viewerReachesWorkspace(viewer: Reacher, workspaceId: string): Promise<boolean> {
  if (viewer.accountId) return verifyAccountWorkspaceAccess(viewer.accountId, workspaceId);
  if (viewer.userId) return (await verifyWorkspaceAccess(viewer.userId, workspaceId)) !== null;
  return false;
}

export async function filterReachableEvidenceBackends<T extends { workspaceId: string | null }>(
  viewer: ExperimentViewer,
  rows: T[],
): Promise<T[]> {
  const workspaceIds = [...new Set(rows.map((r) => r.workspaceId).filter((id): id is string => !!id))];
  const reach = new Map<string, boolean>();
  await Promise.all(workspaceIds.map(async (id) => {
    reach.set(id, await viewerReachesWorkspace(viewer, id));
  }));
  return rows.filter((r) => !r.workspaceId || reach.get(r.workspaceId) === true);
}
