// Who may act on a worker's PR (create, update, merge, supersede).
//
// Two ways in:
//   - the caller's team owns the worker's workspace — the MCP OAuth account and
//     the runner's account differ on multi-account teams, so plain accountId
//     equality is not enough on its own; or
//   - the caller is the account running the worker AND still holds a claim
//     grant (account_workspaces.can_claim) on that workspace. A shared runner
//     (e.g. the Coder service account) sits on its own team and reaches other
//     teams' workspaces only through that grant; the claim path honours it, so
//     without this the task finishes its code and dies on create_pr with a 403.
//     Running the worker alone is not enough — a revoked grant, or a worker
//     the account never claimed, stays refused.

import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';

export async function canActOnWorkerPr(
  account: { id: string; teamId: string | null },
  worker: {
    accountId: string | null;
    workspaceId?: string | null;
    workspace?: { id?: string; teamId: string | null } | null;
  },
  getGrants: typeof getAccountWorkspacePermissions = getAccountWorkspacePermissions,
): Promise<boolean> {
  if (worker.workspace?.teamId != null && worker.workspace.teamId === account.teamId) return true;
  if (worker.accountId == null || worker.accountId !== account.id) return false;

  const workspaceId = worker.workspaceId ?? worker.workspace?.id;
  if (!workspaceId) return false;
  const grants = await getGrants(account.id);
  return grants.some(g => g.workspaceId === workspaceId && g.canClaim);
}
