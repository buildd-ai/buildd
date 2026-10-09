import { PERMISSIONS, roleHas, type Permission, type PermissionOverrides } from '@/lib/permission-registry';

/**
 * What a settings page may offer: one flag per named permission, for one team,
 * with that team's overrides applied. Pure and db-free, so a client component
 * may import the type and a test can build one without the db.
 *
 * The rule is the server's (`can` in permissions.ts): the person's role in the
 * team holds the permission under the team's overrides. A personal team
 * (slug `personal-<userId>`) counts as owned, as `can` treats it.
 */
export type SettingsPermissions = Readonly<Record<Permission, boolean>>;

const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Holds nothing: no team, or the team's overrides could not be read. */
export const NO_PERMISSIONS: SettingsPermissions = Object.freeze(
  Object.fromEntries(ALL_PERMISSIONS.map((p) => [p, false])) as Record<Permission, boolean>,
);

export function settingsPermissions(
  team: { role: string; slug: string } | null,
  userId: string,
  overrides: PermissionOverrides | null,
): SettingsPermissions {
  if (!team) return NO_PERMISSIONS;
  const role = team.slug === `personal-${userId}` ? 'owner' : team.role;
  return Object.freeze(
    Object.fromEntries(ALL_PERMISSIONS.map((p) => [p, roleHas(role, p, overrides)])) as Record<Permission, boolean>,
  );
}

/** The ids of the teams in `byTeam` whose flags hold `permission`. */
export function teamIdsHolding(byTeam: Readonly<Record<string, SettingsPermissions>>, permission: Permission): string[] {
  return Object.entries(byTeam).filter(([, perms]) => perms[permission]).map(([id]) => id);
}
