/**
 * What every /app page shares: the team switcher, the workspace scope the
 * shell's live providers follow, the active team and its zone (spec 3ef37387
 * R-17, R-23).
 *
 * Two statements, sent together in one round: the user's teams (membership
 * role, member and owner counts, timezone) and the workspaces of those teams.
 * Both are scoped to the user in the SQL itself. The result is kept for 30 s
 * per user and team cookie, so a navigation or a live refresh re-running the
 * layout reads nothing.
 *
 * The cache is per server instance. A mutation that changes what the shell
 * shows (creating a workspace or team, joining or leaving one) calls
 * `invalidateAppChrome(userId)` for the acting user; anyone else sees the
 * change within 30 s.
 *
 * The active team follows the same rule as resolveActiveTeamScope (a valid
 * cookie wins, else chooseDefaultTeam), so the header names the team Home shows.
 */
import { cache } from 'react';
import { db } from '@buildd/core/db';
import { teamMembers, teams, workspaces } from '@buildd/core/db/schema';
import { and, eq, or, sql } from 'drizzle-orm';
import { isValidTimezone } from '@buildd/core/timezone';
import { TTLCache } from './cache';
import { chooseDefaultTeam, userWorkspaceScope, type ActiveTeamScope, type UserTeam } from './team-access';

export interface AppChrome {
  /** Teams the user is a member of, oldest membership first (the switcher). */
  teams: UserTeam[];
  /** Every workspace across the user's teams (live providers subscribe to these). */
  workspaceIds: string[];
  /** The active team, its workspaces and its zone. */
  scope: ActiveTeamScope;
  /** The user's role in the active team, or null (personal team without a membership row). */
  role: string | null;
}

export const APP_CHROME_TTL_MS = 30_000;

export interface TeamRow {
  id: string;
  name: string;
  slug: string;
  personalUserId: string | null;
  timezone: string | null;
  role: string | null;
  joinedAt: Date | string | null;
  memberCount: number;
  ownerCount: number;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  teamId: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Selectable = { select: (...args: any[]) => any };

/** The two statements, as builders: renderable for tests (a QueryBuilder), and sent together. */
export function appChromeQueries(userId: string, q: Selectable = db) {
  const membersOf = sql<number>`(select count(*)::int from ${teamMembers} m where m.team_id = ${teams.id})`;
  const ownersOf = sql<number>`(select count(*)::int from ${teamMembers} m where m.team_id = ${teams.id} and m.role = 'owner')`;
  return {
    teams: q
      .select({
        id: teams.id,
        name: teams.name,
        slug: teams.slug,
        personalUserId: teams.personalUserId,
        timezone: teams.timezone,
        role: teamMembers.role,
        joinedAt: teamMembers.joinedAt,
        memberCount: membersOf,
        ownerCount: ownersOf,
      })
      .from(teams)
      .leftJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, userId)))
      .where(or(eq(teamMembers.userId, userId), eq(teams.personalUserId, userId))),
    workspaces: q
      .select({ id: workspaces.id, name: workspaces.name, teamId: workspaces.teamId })
      .from(workspaces)
      .where(userWorkspaceScope(userId)),
  };
}

/** Pure: the shell's view of the two result sets. */
export function deriveAppChrome(
  userId: string,
  cookieTeam: string | null | undefined,
  teamRows: TeamRow[],
  wsRows: WorkspaceRow[],
): AppChrome {
  const memberRows = teamRows
    .filter((t) => t.role != null)
    .sort((a, b) => new Date(a.joinedAt ?? 0).getTime() - new Date(b.joinedAt ?? 0).getTime());
  const userTeams: UserTeam[] = memberRows.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    personalUserId: t.personalUserId ?? null,
    role: t.role!,
    memberCount: Number(t.memberCount) || 1,
    ownerCount: Number(t.ownerCount),
  }));
  const teamIds = [...new Set(teamRows.map((t) => t.id))];
  const workspaceIds = [...new Set(wsRows.map((w) => w.id))];

  let scope: ActiveTeamScope;
  if (teamIds.length === 0) {
    scope = { teamId: null, workspaces: [], timezone: null };
  } else if (cookieTeam && teamIds.includes(cookieTeam)) {
    const tz = teamRows.find((t) => t.id === cookieTeam)?.timezone;
    scope = {
      teamId: cookieTeam,
      workspaces: wsRows.filter((w) => w.teamId === cookieTeam).map((w) => ({ id: w.id, name: w.name })),
      timezone: isValidTimezone(tz) ? tz : null,
    };
  } else {
    scope = chooseDefaultTeam(userId, teamIds, teamRows, wsRows);
  }
  const role = teamRows.find((t) => t.id === scope.teamId)?.role ?? null;
  return { teams: userTeams, workspaceIds, scope, role };
}

export interface AppChromeDeps {
  read(userId: string): Promise<[TeamRow[], WorkspaceRow[]]>;
  now?: () => number;
}

const defaultDeps: AppChromeDeps = {
  async read(userId) {
    const q = appChromeQueries(userId);
    // One round trip: neon-http sends a batch as one request.
    const [teamRows, wsRows] = await db.batch([q.teams, q.workspaces]);
    return [teamRows as TeamRow[], wsRows as WorkspaceRow[]];
  },
};

const chromeCache = new TTLCache<AppChrome>({ maxSize: 2000, ttlMs: APP_CHROME_TTL_MS });
const keyOf = (userId: string, cookieTeam: string | null | undefined) => `${userId}:${cookieTeam ?? ''}`;

/** Errors propagate and are not cached: the layout degrades per surface. */
export async function loadAppChromeUncached(
  userId: string,
  cookieTeam: string | null | undefined,
  deps: AppChromeDeps = defaultDeps,
): Promise<AppChrome> {
  const key = keyOf(userId, cookieTeam);
  const hit = chromeCache.get(key);
  if (hit) return hit;
  const [teamRows, wsRows] = await deps.read(userId);
  const chrome = deriveAppChrome(userId, cookieTeam, teamRows, wsRows);
  chromeCache.set(key, chrome);
  return chrome;
}

/** The layout's read: per request (React cache) over the 30 s cross-request cache. */
export const loadAppChrome = cache((userId: string, cookieTeam: string | null | undefined) =>
  loadAppChromeUncached(userId, cookieTeam));

/** Drop this user's cached shell (every team cookie), after a change they made to it. */
export function invalidateAppChrome(userId: string): void {
  chromeCache.deleteWhere((key) => key.startsWith(`${userId}:`));
}

/** Tests only. */
export function clearAppChromeCache(): void {
  chromeCache.clear();
}
