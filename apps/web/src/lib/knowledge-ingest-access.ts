/**
 * Workspace access for knowledge ingest-job routes (KM v2 spec §3.3, A2).
 *
 * Mirrors the claim route's notion of "workspaces this account may work in":
 * explicit account↔workspace links with canClaim, plus the open workspaces of
 * the account's own team ("open" is open within the owning team).
 */
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { listOpenWorkspaces } from '@/lib/open-workspaces';

export async function getIngestAccessibleWorkspaceIds(
  account: { id: string; teamId: string | null | undefined },
): Promise<Set<string>> {
  const [permissions, open] = await Promise.all([
    getAccountWorkspacePermissions(account.id),
    listOpenWorkspaces(account.teamId ? [account.teamId] : [], { id: true }),
  ]);
  const ids = new Set(permissions.filter(p => p.canClaim).map(p => p.workspaceId));
  for (const w of open) ids.add(w.id);
  return ids;
}
