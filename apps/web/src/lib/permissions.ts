/**
 * Named team permissions — the one place that decides who may do what in a team.
 *
 * Every team-scoped permission decision is a lookup in `PERMISSIONS` (permission-registry.ts):
 * which team roles hold it by default, and the minimum API-key level that holds
 * it (or `null` when no API key may). Call sites ask by name:
 *
 *   roleHas(role, 'manage_team_members')          // pure, UI that knows the role
 *   await can(caller, 'manage_team_members', id)  // routes: session OR API key
 *
 * Resolution reads the registry's `defaultRoles` and nothing else: no team
 * can change them. The inventory these defaults reproduce lives
 * in docs/specs/team-permissions.md — a default here that disagrees with the
 * call site it names is a behaviour change, not a cleanup.
 *
 * Deliberately not here: workspace reach (`verifyWorkspaceAccess`,
 * `verifyAccountWorkspaceAccess`) — whether the caller can see a workspace at
 * all — and token-scope route policy (`token-route-policy.ts`), which decides
 * which routes a scoped token may call. Both run before a permission check.
 *
 * Imports no app module at runtime: team-access.ts builds on this file, and
 * many route tests replace team-access wholesale.
 * The registry and the pure checks live in permission-registry.ts (no runtime
 * imports at all) and are re-exported here.
 * The schema is a namespace import for the same reason: route tests mock it
 * with only the tables they touch, and a named import of a table the mock
 * leaves out fails at link time even for a route that only calls `roleHas`.
 */
import { cache } from 'react';
import { db } from '@buildd/core/db';
import * as schema from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import {
  holds,
  keyHolds,
  PERMISSIONS,
  type Permission,
  type TeamRole,
  type TeamScopeCaller,
} from './permission-registry';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export {
  API_KEY_LEVELS,
  isApiKeyLevel,
  isTeamRole,
  keyLevelHas,
  PERMISSIONS,
  roleHas,
  TEAM_ROLES,
  type ApiKeyLevel,
  type Permission,
  type PermissionDef,
  type TeamRole,
  type TeamScopeCaller,
} from './permission-registry';

/**
 * Every team the user belongs to, with their role in it. The user's personal
 * team (slug = personal-{userId}) counts as owned even without a teamMembers
 * row, mirroring getUserTeamIds' fallback.
 *
 * Cached per-request via React cache() (primitive arg).
 */
export const getUserTeamRoles = cache(async (userId: string): Promise<Map<string, TeamRole | string>> => {
  const [memberships, personalTeam] = await Promise.all([
    db.query.teamMembers.findMany({
      where: sqlWhere(eq(schema.teamMembers.userId, userId)),
      columns: { teamId: true, role: true },
    }),
    db.query.teams.findFirst({
      where: sqlWhere(eq(schema.teams.slug, `personal-${userId}`)),
      columns: { id: true },
    }),
  ]);
  const roles = new Map<string, TeamRole | string>(memberships.map(m => [m.teamId, m.role]));
  if (personalTeam) roles.set(personalTeam.id, 'owner');
  return roles;
});

/**
 * The teams in which the caller holds `permission`: for a session, teams whose
 * role grants it; for an API key, the key's own team when its level does,
 * otherwise none. Scoped tokens carry `scopes`, not a level: callers map them
 * to a level before asking (e.g. an `admin` scope → 'admin'), as the memory
 * review route does; this reads only `level`.
 */
export async function teamIdsWhere(caller: TeamScopeCaller, permission: Permission): Promise<string[]> {
  const { defaultRoles, minKeyLevel } = PERMISSIONS[permission];
  if (caller.kind === 'account') {
    return keyHolds(minKeyLevel, caller.level) ? [caller.teamId] : [];
  }
  const roles = [...(await getUserTeamRoles(caller.userId))];
  return roles.filter(([, role]) => holds(defaultRoles, role)).map(([teamId]) => teamId);
}

/** Whether the caller holds `permission` in `teamId`. Fails closed. */
export async function can(caller: TeamScopeCaller, permission: Permission, teamId: string): Promise<boolean> {
  if (!teamId) return false;
  return (await teamIdsWhere(caller, permission)).includes(teamId);
}
