import { db } from '@buildd/core/db';
import { workspaces, accountWorkspaces } from '@buildd/core/db/schema';
import { eq, and, or, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import { getUserTeamIds } from '@/lib/team-access';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The set of workspaces a caller can reach: every workspace owned by one of
 * `teamIds`, plus any explicitly linked `workspaceIds` (accountWorkspaces).
 * Resolution never looks outside this set.
 */
export interface WorkspaceScope {
  teamIds: string[];
  workspaceIds?: string[];
}

/**
 * Who is resolving. An explicit scope is used as-is; an API account reaches
 * its own team plus its explicit accountWorkspaces links; a session user
 * reaches the teams they belong to.
 */
export type WorkspaceCaller =
  | WorkspaceScope
  | { account: { id: string; teamId: string } }
  | { userId: string };

async function toScope(caller: WorkspaceCaller): Promise<WorkspaceScope> {
  if ('teamIds' in caller) return caller;
  if ('account' in caller) {
    return {
      teamIds: [caller.account.teamId],
      workspaceIds: await getLinkedWorkspaceIds(caller.account.id),
    };
  }
  return { teamIds: await getUserTeamIds(caller.userId) };
}

function scopePredicate(scope: WorkspaceScope): SQL | null {
  const arms: SQL[] = [];
  if (scope.teamIds.length > 0) arms.push(inArray(workspaces.teamId, scope.teamIds));
  if (scope.workspaceIds && scope.workspaceIds.length > 0) {
    arms.push(inArray(workspaces.id, scope.workspaceIds));
  }
  if (arms.length === 0) return null;
  return arms.length === 1 ? arms[0] : or(...arms)!;
}

/**
 * Resolve a workspace identifier (UUID, repo name, or workspace name) to a
 * workspace row, searching only the workspaces the caller can reach. Returns null when
 * nothing in scope matches.
 */
export async function resolveWorkspace(raw: string, caller: WorkspaceCaller) {
  const inScope = scopePredicate(await toScope(caller));
  if (!inScope) return null;

  // UUID → direct lookup
  if (UUID_RE.test(raw)) {
    return (await db.query.workspaces.findFirst({ where: and(eq(workspaces.id, raw), inScope) })) ?? null;
  }

  // Try exact repo match first (e.g., "buildd-ai/moa")
  const byRepo = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.repo, raw), inScope),
  });
  if (byRepo) return byRepo;

  // Try name match (case-insensitive) or repo suffix match
  const byName = await db.query.workspaces.findFirst({
    where: and(
      or(
        ilike(workspaces.name, raw),
        sql`${workspaces.repo} ILIKE ${'%/' + raw}`,
      ),
      inScope,
    ),
  });
  return byName || null;
}

/**
 * Workspace ids an API account is explicitly linked to (accountWorkspaces),
 * optionally narrowed to links carrying a permission. Used to build the
 * `workspaceIds` arm of a WorkspaceScope for key-authenticated callers.
 */
export async function getLinkedWorkspaceIds(
  accountId: string,
  permission?: 'canClaim' | 'canCreate',
): Promise<string[]> {
  const links = await db.query.accountWorkspaces.findMany({
    where: and(
      eq(accountWorkspaces.accountId, accountId),
      permission === 'canClaim' ? eq(accountWorkspaces.canClaim, true) : undefined,
      permission === 'canCreate' ? eq(accountWorkspaces.canCreate, true) : undefined,
    ),
    columns: { workspaceId: true },
  });
  return links.map(l => l.workspaceId);
}

/**
 * Auto-resolve workspace for an API account that has no workspaceId specified.
 * Returns workspace ID if account is linked to exactly one workspace with canCreate.
 * Returns an error object otherwise with an actionable message.
 */
export async function autoResolveAccountWorkspace(
  accountId: string,
  accountName: string,
): Promise<{ workspaceId: string } | { error: string; status: number }> {
  const linked = await db.query.accountWorkspaces.findMany({
    where: and(
      eq(accountWorkspaces.accountId, accountId),
      eq(accountWorkspaces.canCreate, true),
    ),
    with: { workspace: { columns: { id: true, name: true } } },
  });

  if (linked.length === 0) {
    return {
      error: `Account "${accountName}" has no workspace links. Link a workspace at buildd.dev/settings.`,
      status: 400,
    };
  }

  if (linked.length === 1) {
    return { workspaceId: linked[0].workspaceId };
  }

  const names = linked.map(l => l.workspace?.name || l.workspaceId).join(', ');
  return {
    error: `Account "${accountName}" is linked to ${linked.length} workspaces (${names}). Specify workspaceId.`,
    status: 400,
  };
}
