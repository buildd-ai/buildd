import { cache } from 'react';
import { db } from '@buildd/core/db';
import { teamMembers, workspaces, accountWorkspaces, teams, accounts } from '@buildd/core/db/schema';
import { eq, and, or, inArray, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';

/**
 * Builds the two scope subqueries below without a db handle, so the predicate
 * is renderable (and therefore assertable) independently of any connection —
 * see team-access-workspace-scope.test.ts.
 */
const qb = new QueryBuilder();

type TeamRole = 'owner' | 'admin' | 'member';

const ROLE_HIERARCHY: Record<TeamRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

/**
 * Verify a user has access to a workspace via team membership.
 * Optionally checks for a minimum role level.
 *
 * Cached per-request via React cache() so layout + page share the same result.
 */
export const verifyWorkspaceAccess = cache(async (
  userId: string,
  workspaceId: string,
  requiredRole?: TeamRole
): Promise<{ teamId: string; role: TeamRole } | null> => {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true, accessMode: true },
  });

  if (!workspace) return null;

  // Access is always decided by membership of the workspace's own team.
  // `accessMode: 'open'` does not widen session access beyond that team: it
  // governs which of the team's API accounts may act without an explicit
  // accountWorkspaces link (see verifyAccountWorkspaceAccess).
  const membership = await db.query.teamMembers.findFirst({
    where: and(
      eq(teamMembers.teamId, workspace.teamId),
      eq(teamMembers.userId, userId)
    ),
  });

  if (!membership) return null;

  const role = membership.role as TeamRole;

  if (requiredRole && ROLE_HIERARCHY[role] < ROLE_HIERARCHY[requiredRole]) {
    return null;
  }

  return { teamId: workspace.teamId, role };
});

/**
 * Verify an API key account has access to a workspace.
 *
 * Two ways in:
 *   1. the workspace is `accessMode: 'open'` AND the account belongs to the
 *      workspace's own team — "open" means open within the owning team; or
 *   2. an explicit accountWorkspaces link (with the requested permission).
 *
 * Cached per-request via React cache() so layout + page share the same result.
 */
export const verifyAccountWorkspaceAccess = cache(async (
  accountId: string,
  workspaceId: string,
  permission?: 'canClaim' | 'canCreate'
): Promise<boolean> => {
  // Check workspace access mode first
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { id: true, teamId: true, accessMode: true },
  });

  if (!workspace) return false;

  if (workspace.accessMode === 'open') {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
      columns: { teamId: true },
    });
    if (account && account.teamId === workspace.teamId) return true;
  }

  // Check explicit link
  const link = await db.query.accountWorkspaces.findFirst({
    where: and(
      eq(accountWorkspaces.accountId, accountId),
      eq(accountWorkspaces.workspaceId, workspaceId)
    ),
  });

  if (!link) return false;

  if (permission === 'canClaim' && !link.canClaim) return false;
  if (permission === 'canCreate' && !link.canCreate) return false;

  return true;
});

const ADMIN_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

/**
 * Team IDs in which the user holds admin or owner. Includes the user's
 * personal team (slug = personal-{userId}), which they own by definition —
 * mirrors the getUserTeamIds fallback for accounts missing a teamMembers row.
 *
 * Cached per-request via React cache().
 */
export const getUserAdminTeamIds = cache(async (userId: string): Promise<string[]> => {
  const [memberships, personalTeam] = await Promise.all([
    db.query.teamMembers.findMany({
      where: eq(teamMembers.userId, userId),
      columns: { teamId: true, role: true },
    }),
    db.query.teams.findFirst({
      where: eq(teams.slug, `personal-${userId}`),
      columns: { id: true },
    }),
  ]);
  const ids = new Set(memberships.filter(m => ADMIN_ROLES.has(m.role)).map(m => m.teamId));
  if (personalTeam) ids.add(personalTeam.id);
  return [...ids];
});

/**
 * The principal behind a request, in the shape the team-scope helpers need.
 * A session resolves to its user; an API key resolves to its account, whose
 * reach is its own team.
 */
export type TeamScopeCaller =
  | { kind: 'user'; userId: string }
  | { kind: 'account'; accountId: string; teamId: string; level: string | null | undefined };

/**
 * Teams the caller may perform admin-tier actions in: for a session, teams
 * where the user is admin/owner; for an API key, the key's own team when the
 * key is admin level, otherwise none.
 */
export async function getCallerAdminTeamIds(caller: TeamScopeCaller): Promise<string[]> {
  if (caller.kind === 'account') {
    return caller.level === 'admin' ? [caller.teamId] : [];
  }
  return getUserAdminTeamIds(caller.userId);
}

/** Whether the caller may perform admin-tier actions in `teamId`. */
export async function canCallerAdminTeam(caller: TeamScopeCaller, teamId: string): Promise<boolean> {
  const ids = await getCallerAdminTeamIds(caller);
  return ids.includes(teamId);
}

/**
 * Get all workspace IDs accessible to a user via their team memberships.
 *
 * Cached per-request via React cache() so layout + page share the same result.
 * Both the protected layout and the page it renders resolve this scope, and it
 * is re-resolved on every Pusher-driven router.refresh().
 *
 * One statement, deliberately. This used to be four strictly sequential
 * queries — personal team by slug, that team's workspaces, the user's
 * memberships, those teams' workspaces — and neon-http has no pooling, so each
 * one cost a separate HTTP round trip for a predicate Postgres can evaluate in
 * a single pass. The two arms are unchanged and still OR'd:
 *
 *   1. the personal team (slug = personal-{userId}), which is the fallback for
 *      accounts predating teamMembers enforcement; and
 *   2. every team the user actually has a teamMembers row for.
 *
 * SELECT DISTINCT does the set union the old Set<string> accumulator did.
 * `accountWorkspaces` is intentionally not consulted here — that is the API-key
 * account path (verifyAccountWorkspaceAccess), not the session-user path.
 *
 * Two invariants this leans on. `teams.slug` is UNIQUE (schema.ts), so the
 * personal-team subquery matches at most one row — exactly what the old
 * findFirst did, not a widening. And the return value is an unordered set, as
 * it always was: neither of the old findMany calls carried an ORDER BY either.
 */
export const getUserWorkspaceIds = cache(async (userId: string): Promise<string[]> => {
  const rows = await db
    .selectDistinct({ id: workspaces.id })
    .from(workspaces)
    .where(
      or(
        // 1. Workspaces via personal team (for users missing team_members rows)
        inArray(
          workspaces.teamId,
          qb.select({ id: teams.id }).from(teams).where(eq(teams.slug, `personal-${userId}`)),
        ),
        // 2. Workspaces via team membership
        inArray(
          workspaces.teamId,
          qb.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId)),
        ),
      ),
    );

  // DISTINCT already dedupes in Postgres; the Set keeps the contract explicit
  // and independent of the query shape.
  return [...new Set(rows.map(r => r.id))];
});

/**
 * Get all workspace IDs that belong to a team.
 *
 * Cached per-request via React cache() so layout + page share the same result.
 */
export const getTeamWorkspaceIds = cache(async (teamId: string): Promise<string[]> => {
  const ws = await db.query.workspaces.findMany({
    where: eq(workspaces.teamId, teamId),
    columns: { id: true },
  });
  return ws.map((w) => w.id);
});

/**
 * Get all team IDs a user belongs to, including their personal team.
 * Falls back to the personal team (slug = personal-{userId}) so that
 * accounts created before teamMembers enforcement still resolve their
 * own missions and workspaces — mirrors the getUserWorkspaceIds fallback.
 *
 * Cached per-request via React cache() so layout + page share the same result.
 * resolveActiveTeamId calls this too, so a page that resolves both pays once.
 */
export const getUserTeamIds = cache(async (userId: string): Promise<string[]> => {
  // The two reads share no inputs, so they go out together — neon-http bills a
  // full HTTP round trip per statement, and this helper is on the critical path
  // of every team-scoped surface.
  const [memberships, personalTeam] = await Promise.all([
    db.query.teamMembers.findMany({
      where: eq(teamMembers.userId, userId),
      columns: { teamId: true },
    }),
    // Personal-team fallback for accounts missing a teamMembers row
    db.query.teams.findFirst({
      where: eq(teams.slug, `personal-${userId}`),
      columns: { id: true },
    }),
  ]);

  const ids = new Set(memberships.map(m => m.teamId));
  if (personalTeam) {
    ids.add(personalTeam.id);
  }

  return [...ids];
});

/**
 * Resolve the team IDs a request may act on.
 *
 * An API account is scoped to exactly its own team — it never inherits the
 * teams of any user who happens to be a member of that team. A session user
 * resolves to every team they belong to (plus their personal team).
 *
 * NOT React cache()-wrapped, unlike its siblings: both parameters are objects,
 * and cache() keys non-primitives on referential identity — fresh object
 * literals at the call site would miss every time and only grow the cache. Its
 * inner getUserTeamIds call is cached, which is where the round trips are.
 */
export async function resolveAccountTeamIds(
  user: { id: string } | null | undefined,
  apiAccount: { teamId: string } | null
): Promise<string[]> {
  if (apiAccount) return [apiAccount.teamId];
  if (user) return getUserTeamIds(user.id);
  return [];
}

/**
 * The user's current role on a team, or null when they do not belong to it.
 * A user's own personal team (slug = personal-{userId}) counts as owner even
 * without a teamMembers row, mirroring the getUserTeamIds fallback.
 *
 * Cached per-request via React cache() (primitive args).
 */
export const getUserTeamRole = cache(async (userId: string, teamId: string): Promise<TeamRole | null> => {
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    columns: { role: true },
  });
  if (membership?.role) return membership.role as TeamRole;

  const team = await db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    columns: { slug: true },
  });
  if (team?.slug === `personal-${userId}`) return 'owner';
  return null;
});

/**
 * Get the user's default (personal) team ID.
 * This is the team with slug 'personal-{userId}'.
 *
 * Cached per-request via React cache() so layout + page share the same result.
 */
export const getUserDefaultTeamId = cache(async (userId: string): Promise<string | null> => {
  const team = await db.query.teams.findFirst({
    where: eq(teams.slug, `personal-${userId}`),
    columns: { id: true },
  });

  return team?.id || null;
});

/**
 * Resolve the single "active team" for a session from the `buildd-team` cookie.
 *
 * The cookie is honored only when it names a team the user is a member of;
 * otherwise resolution falls back to the user's personal team, then their first
 * team. Returns null only when the user belongs to no team. This is the single
 * source of truth for team-scoped (namespaced) views — see
 * docs/specs/team-namespace-scoping.md.
 *
 * Cached per-request via React cache() so layout + page share the same result.
 */
export const resolveActiveTeamId = cache(async (
  userId: string,
  cookieValue: string | null | undefined,
): Promise<string | null> => {
  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) return null;
  if (cookieValue && teamIds.includes(cookieValue)) return cookieValue;

  const personalId = await getUserDefaultTeamId(userId);
  if (personalId && teamIds.includes(personalId)) return personalId;

  return teamIds[0];
});

export type UserTeam = {
  id: string;
  name: string;
  slug: string;
  role: string;
  memberCount: number;
};

/**
 * Get all teams a user belongs to with role and member counts.
 * Cached per-request via React cache() so layout + page share the same result.
 */
export const getUserTeamsWithDetails = cache(async (userId: string): Promise<UserTeam[]> => {
  const memberships = await db.query.teamMembers.findMany({
    where: eq(teamMembers.userId, userId),
    // Explicit column list — `team: true` selects every column in schema.ts.
    // This runs in the cached app-layout path, so a schema change reaching it
    // during a deploy takes the whole shell down.
    with: { team: { columns: { id: true, name: true, slug: true, plan: true } } },
  });

  const validMemberships = memberships.filter(m => m.team != null);
  if (validMemberships.length === 0) return [];

  const memberTeamIds = validMemberships.map(m => m.teamId);

  let countMap = new Map<string, number>();
  try {
    const memberCounts = await db
      .select({
        teamId: teamMembers.teamId,
        count: sql<number>`count(*)::int`,
      })
      .from(teamMembers)
      .where(inArray(teamMembers.teamId, memberTeamIds))
      .groupBy(teamMembers.teamId);

    countMap = new Map(memberCounts.map(mc => [mc.teamId, mc.count]));
  } catch {
    // Member counts are non-critical, default to 1
  }

  return validMemberships
    .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime())
    .map(m => ({
      id: m.team.id,
      name: m.team.name,
      slug: m.team.slug,
      role: m.role,
      memberCount: countMap.get(m.teamId) || 1,
    }));
});
