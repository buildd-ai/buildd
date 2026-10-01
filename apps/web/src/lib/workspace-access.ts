import { db } from '@buildd/core/db';
import { workspaces, accountWorkspaces } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { getUserTeamIds, getUserWorkspaceIds } from '@/lib/team-access';
import { getAccountWorkspacePermissions } from '@/lib/account-workspace-cache';
import { resolveWorkspace } from '@/lib/workspace-resolver';
import { accountReachesWorkspace, type WorkspacePermission } from '@/lib/workspace-reach';
import { isUuid } from '@/lib/uuid';
import { tokenWorkspaceAllowed } from '@buildd/core/token-scopes';

/**
 * Workspace reach, shared by every surface that lists workspaces or acts on one
 * named by the caller: `GET /api/workspaces`, `GET /api/tasks`,
 * `POST /api/tasks` and `POST /api/missions`. Listing and acting answer to the
 * same rule, so a workspace a caller can see is one it can use, and one it
 * cannot use never shows up in its list.
 *
 * - An API account (key or OAuth token) follows `accountReachesWorkspace`: its
 *   own team's open workspaces, plus workspaces it is explicitly linked to.
 *   Another team's open workspace is never reachable without a link.
 * - A session user reaches every workspace of every team they belong to.
 */
export type WorkspaceAccessCaller =
  | { account: { id: string; teamId: string; name?: string | null; workspaceIds?: string[] | null } }
  | { userId: string };

type WorkspaceRow = NonNullable<Awaited<ReturnType<typeof resolveWorkspace>>>;

export type WorkspaceAccessResult =
  | { ok: true; workspace: WorkspaceRow }
  | { ok: false; reason: 'not_found' | 'no_access'; status: 404 | 403; error: string };

/**
 * Ids of every workspace the caller can reach. `permission` narrows an
 * account's links to those carrying it; own-team open workspaces qualify
 * for any permission, exactly as in `accountReachesWorkspace`.
 */
export async function listReachableWorkspaceIds(
  caller: WorkspaceAccessCaller,
  permission?: WorkspacePermission,
): Promise<string[]> {
  if (!('account' in caller)) return getUserWorkspaceIds(caller.userId);

  const { account } = caller;
  const [links, ownOpen] = await Promise.all([
    getAccountWorkspacePermissions(account.id),
    db.query.workspaces.findMany({
      where: and(eq(workspaces.teamId, account.teamId), eq(workspaces.accessMode, 'open')),
      columns: { id: true, teamId: true, accessMode: true },
    }),
  ]);

  const ids = new Set<string>();
  for (const l of links) {
    if (!permission || l[permission]) ids.add(l.workspaceId);
  }
  // The query is already team-scoped; the rule is re-applied so this list can
  // never disagree with what resolveWorkspaceAccess would allow.
  for (const ws of ownOpen) {
    if (accountReachesWorkspace(account, ws, null, permission)) ids.add(ws.id);
  }
  // A workspace-restricted token reaches its own list and nothing else.
  return [...ids].filter(id => tokenWorkspaceAllowed(account.workspaceIds, id));
}

/**
 * Resolve a caller-supplied workspace reference (UUID, `owner/repo`, or name)
 * and decide whether the caller may act on it.
 *
 * Distinguishes the two failures so the caller gets an actionable error:
 * - `not_found` (404) — nothing by that reference exists;
 * - `no_access` (403) — the workspace exists but the caller cannot reach it.
 *
 * Existence outside the caller's scope is only confirmed for an exact
 * reference (UUID or exact `owner/repo`); a bare name is resolved within the
 * caller's scope alone, since names are not unique across teams.
 */
export async function resolveWorkspaceAccess(
  raw: string,
  caller: WorkspaceAccessCaller,
  permission?: WorkspacePermission,
): Promise<WorkspaceAccessResult> {
  const ref = raw.trim();
  const notFound: WorkspaceAccessResult = {
    ok: false,
    reason: 'not_found',
    status: 404,
    error: `No workspace found matching "${ref}"`,
  };
  const noAccess = (): WorkspaceAccessResult => ({
    ok: false,
    reason: 'no_access',
    status: 403,
    error: 'account' in caller
      ? `No access to workspace "${ref}": account "${caller.account.name ?? caller.account.id}" is not linked to it` +
        `${permission ? ` with ${permission}` : ''}, and it is not an open workspace of the account's own team. ` +
        `An admin of the workspace's team can link the account (POST /api/workspaces/{id}/accounts).`
      : `No access to workspace "${ref}": you are not a member of the team that owns it.`,
  });

  if (!ref) return notFound;

  // Resolution scope: the account's team plus its links, or the user's teams.
  // Being found here is necessary but not sufficient — the rule decides.
  const found = await resolveWorkspace(
    ref,
    'account' in caller ? { account: caller.account } : { userId: caller.userId },
  );

  if (!found) {
    const exists = await existsByExactRef(ref);
    return exists ? noAccess() : notFound;
  }

  if ('account' in caller) {
    if (!tokenWorkspaceAllowed(caller.account.workspaceIds, found.id)) return noAccess();
    const link = await db.query.accountWorkspaces.findFirst({
      where: and(
        eq(accountWorkspaces.accountId, caller.account.id),
        eq(accountWorkspaces.workspaceId, found.id),
      ),
      columns: { canClaim: true, canCreate: true },
    });
    return accountReachesWorkspace(caller.account, found, link, permission)
      ? { ok: true, workspace: found }
      : noAccess();
  }

  const teamIds = await getUserTeamIds(caller.userId);
  return teamIds.includes(found.teamId) ? { ok: true, workspace: found } : noAccess();
}

async function existsByExactRef(ref: string): Promise<boolean> {
  if (isUuid(ref)) {
    return !!(await db.query.workspaces.findFirst({ where: eq(workspaces.id, ref), columns: { id: true } }));
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(ref)) {
    return !!(await db.query.workspaces.findFirst({ where: eq(workspaces.repo, ref), columns: { id: true } }));
  }
  return false;
}
