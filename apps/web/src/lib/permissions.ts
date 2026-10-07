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
 * Resolution runs through `effectiveRoles`, which today returns the registry's
 * `defaultRoles` and nothing else. The inventory these defaults reproduce lives
 * in docs/specs/team-permissions.md — a default here that disagrees with the
 * call site it names is a behaviour change, not a cleanup.
 *
 * Deliberately not here: workspace reach (`verifyWorkspaceAccess`,
 * `verifyAccountWorkspaceAccess`) — whether the caller can see a workspace at
 * all — and token-scope route policy (`token-route-policy.ts`), which decides
 * which routes a scoped token may call. Both run before a permission check.
 *
 * Imports no app module at runtime: team-access.ts builds its admin-tier
 * helpers on this file, and many route tests replace team-access wholesale.
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
  effectiveRoles,
  sanitizeOverrides,
  holds,
  keyHolds,
  OWNER_ADMIN,
  PERMISSIONS,
  type ApiKeyLevel,
  type Permission,
  type PermissionOverrides,
  type TeamRole,
  type TeamScopeCaller,
} from './permission-registry';

export {
  API_KEY_LEVELS,
  isApiKeyLevel,
  isTeamRole,
  keyLevelHas,
  LOCKED_PERMISSIONS,
  parseOverridesInput,
  sanitizeOverrides,
  PERMISSIONS,
  roleHas,
  TEAM_ROLES,
  type ApiKeyLevel,
  type Permission,
  type PermissionDef,
  type PermissionOverrides,
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
      where: eq(schema.teamMembers.userId, userId),
      columns: { teamId: true, role: true },
    }),
    db.query.teams.findFirst({
      where: eq(schema.teams.slug, `personal-${userId}`),
      columns: { id: true },
    }),
  ]);
  const roles = new Map<string, TeamRole | string>(memberships.map(m => [m.teamId, m.role]));
  if (personalTeam) roles.set(personalTeam.id, 'owner');
  return roles;
});

/**
 * A team's permission overrides (teams.permission_overrides), sanitized.
 * Cached per request, so every roleHas/can in one render or route reads the
 * row once. A missing team is `{}` (defaults). A failed read is NOT swallowed:
 * an override can take a permission away, so guessing "defaults" on error
 * could widen access. The error propagates and the request fails closed.
 */
export const getTeamPermissionOverrides = cache(async (teamId: string): Promise<PermissionOverrides> => {
  if (!teamId) return {};
  const team = await db.query.teams.findFirst({
    where: eq(schema.teams.id, teamId),
    columns: { permissionOverrides: true },
  });
  return sanitizeOverrides(team?.permissionOverrides);
});

/** Overrides for several teams at once (each read is the cached one above). */
export async function getTeamsPermissionOverrides(teamIds: readonly string[]): Promise<Map<string, PermissionOverrides>> {
  const unique = [...new Set(teamIds)];
  const all = await Promise.all(unique.map(id => getTeamPermissionOverrides(id)));
  return new Map(unique.map((id, i) => [id, all[i]]));
}

/** A role grant plus key floor, the shape every check below resolves to. */
type Grant = {
  roles: (teamId: string, overrides: PermissionOverrides) => readonly TeamRole[];
  minKeyLevel: ApiKeyLevel | null;
};

/**
 * Scoped tokens carry `scopes`, not a level. Callers map them to a level
 * before asking (e.g. an `admin` scope → 'admin'), as the memory review route
 * does today; `can` reads only `level`.
 */

async function teamIdsGranted(caller: TeamScopeCaller, grant: Grant): Promise<string[]> {
  if (caller.kind === 'account') {
    return keyHolds(grant.minKeyLevel, caller.level) ? [caller.teamId] : [];
  }
  const roles = [...(await getUserTeamRoles(caller.userId))];
  const overrides = await Promise.all(roles.map(([teamId]) => getTeamPermissionOverrides(teamId)));
  return roles.filter(([teamId, role], i) => holds(grant.roles(teamId, overrides[i]), role)).map(([teamId]) => teamId);
}

function grantFor(permission: Permission): Grant {
  return { roles: (_teamId, overrides) => effectiveRoles(permission, overrides), minKeyLevel: PERMISSIONS[permission].minKeyLevel };
}

/**
 * The teams in which the caller holds `permission`: for a session, teams whose
 * role grants it; for an API key, the key's own team when its level does,
 * otherwise none.
 */
export async function teamIdsWhere(caller: TeamScopeCaller, permission: Permission): Promise<string[]> {
  return teamIdsGranted(caller, grantFor(permission));
}

/** Whether the caller holds `permission` in `teamId`. Fails closed. */
export async function can(caller: TeamScopeCaller, permission: Permission, teamId: string): Promise<boolean> {
  if (!teamId) return false;
  return (await teamIdsWhere(caller, permission)).includes(teamId);
}

/**
 * The pre-registry "admin tier": owner/admin role, or an admin-level key of the
 * team. team-access's getCallerAdminTeamIds / canCallerAdminTeam resolve
 * through this until their call sites move to a named permission.
 */
export const ADMIN_TIER: Grant = { roles: () => OWNER_ADMIN, minKeyLevel: 'admin' };

export async function teamIdsWithAdminTier(caller: TeamScopeCaller): Promise<string[]> {
  return teamIdsGranted(caller, ADMIN_TIER);
}
