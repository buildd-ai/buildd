/**
 * Test fixture: a stand-in for `can` from '@/lib/permissions' that route tests
 * mock in, so a route's permission check runs against the real registry
 * defaults without a teamMembers/teams db mock. `roleOf` names the caller's
 * team role (`null`/`undefined` = no membership, which holds nothing). An API
 * key holds a permission in its own team at the registry's key floor.
 *
 * The real `can` (membership rows, personal-team fallback, overrides) is
 * covered by connector-team-auth.test.ts.
 */
import { keyLevelHas, roleHas, type Permission, type TeamScopeCaller } from './permission-registry';

type Role = string | null | undefined;
export type RoleOf = (userId: string, teamId: string) => Role | Promise<Role>;

export function fakeCan(roleOf: RoleOf) {
  return async (caller: TeamScopeCaller, permission: Permission, teamId: string): Promise<boolean> => {
    if (caller.kind === 'account') return caller.teamId === teamId && keyLevelHas(caller.level, permission);
    return roleHas(await roleOf(caller.userId, teamId), permission, null);
  };
}
