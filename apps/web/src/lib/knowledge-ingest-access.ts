/**
 * Workspace access for knowledge ingest-job routes (KM v2 spec §3.3, A2).
 *
 * Mirrors the claim route's notion of "workspaces this account may work in":
 * explicit account↔workspace links with canClaim, plus open-access workspaces.
 */
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';

export async function getIngestAccessibleWorkspaceIds(accountId: string): Promise<Set<string>> {
  const permissions = await getAccountWorkspacePermissions(accountId);
  const ids = new Set(permissions.filter(p => p.canClaim).map(p => p.workspaceId));

  const open = await db.query.workspaces.findMany({
    where: eq(workspaces.accessMode, 'open'),
    columns: { id: true },
  });
  for (const w of open) ids.add(w.id);

  return ids;
}
