// Request-scope checks for the /api/mcp entry point. The MCP URL carries
// caller-supplied `?workspace=`, `?worker=` and `?repo=` parameters; each is
// resolved only within the authenticated account's reach before any tool runs.

import { db } from '@buildd/core/db';
import { accountWorkspaces, workspaces, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getLinkedWorkspaceIds } from '@/lib/workspace-resolver';

type McpAccount = { id: string; teamId: string };

// Ids are compared against uuid columns; a malformed one would make Postgres
// throw instead of simply matching nothing, so it is out of scope up front.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A `?workspace=` id pins the workspace this MCP session acts in. It must
 * belong to the calling account's team, or the account must hold an explicit
 * accountWorkspaces link to it. An unknown id is simply not in scope.
 */
export async function isWorkspaceInCallerScope(workspaceId: string, account: McpAccount): Promise<boolean> {
  if (!UUID_RE.test(workspaceId)) return false;
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  if (!ws) return false;
  if (ws.teamId === account.teamId) return true;
  const link = await db.query.accountWorkspaces.findFirst({
    where: and(
      eq(accountWorkspaces.accountId, account.id),
      eq(accountWorkspaces.workspaceId, workspaceId),
    ),
    columns: { workspaceId: true },
  });
  return !!link;
}

/**
 * A `?worker=` id names the worker this MCP session acts as. It must be a
 * worker run by the calling account, or one in a workspace of the calling
 * account's team.
 */
export async function isWorkerInCallerScope(workerId: string, account: McpAccount): Promise<boolean> {
  if (!UUID_RE.test(workerId)) return false;
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
 * Whether any workspace the account can act in — its own team's, or one it is
 * explicitly linked to — is `sensitive`. Used where an action picks its own
 * workspace (e.g. a claim) and the connection cannot know which one it will
 * be. Fail-closed: a lookup error counts as reaching a sensitive workspace.
 */
export async function callerReachesSensitiveWorkspace(account: McpAccount): Promise<boolean> {
  try {
    const linkedIds = await getLinkedWorkspaceIds(account.id);
    const inScope = linkedIds.length > 0
      ? or(eq(workspaces.teamId, account.teamId), inArray(workspaces.id, linkedIds))
      : eq(workspaces.teamId, account.teamId);
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.dataClass, 'sensitive'), inScope))
      .limit(1);
    return rows.length > 0;
  } catch {
    return true;
  }
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
