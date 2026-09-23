// Request-scope checks for the /api/mcp entry point. The MCP URL carries
// caller-supplied `?worker=` and `?repo=` parameters; both are resolved only
// within the authenticated account's reach before any tool runs.

import { db } from '@buildd/core/db';
import { workspaces, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getLinkedWorkspaceIds } from '@/lib/workspace-resolver';

type McpAccount = { id: string; teamId: string };

/**
 * A `?worker=` id names the worker this MCP session acts as. It must be a
 * worker run by the calling account, or one in a workspace of the calling
 * account's team.
 */
export async function isWorkerInCallerScope(workerId: string, account: McpAccount): Promise<boolean> {
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
    columns: { accountId: true },
    with: { workspace: { columns: { teamId: true } } },
  });
  if (!worker) return false;
  if (worker.accountId === account.id) return true;
  return (worker as { workspace?: { teamId?: string } | null }).workspace?.teamId === account.teamId;
}

/**
 * Resolve `?repo=` to a workspace id among the account's own team's
 * workspaces and those it is explicitly linked to. Exact match first, then
 * case-insensitive.
 */
export async function resolveRepoParamWorkspaceId(repo: string, account: McpAccount): Promise<string | undefined> {
  const linkedIds = await getLinkedWorkspaceIds(account.id);
  const inScope = linkedIds.length > 0
    ? or(eq(workspaces.teamId, account.teamId), inArray(workspaces.id, linkedIds))
    : eq(workspaces.teamId, account.teamId);

  const exact = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.repo, repo), inScope),
    columns: { id: true },
  });
  if (exact) return exact.id;

  const [row] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(sql`LOWER(${workspaces.repo}) = LOWER(${repo})`, inScope))
    .limit(1);
  return row?.id;
}
