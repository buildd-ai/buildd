import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';
import { personalRoleVisibleSql, pickVisibleRoleRow, ROLE_VISIBILITY_COLUMNS } from '@buildd/core/role-visibility';

/**
 * Validation for `tasks.requiredConnectors` — the task-level opt-in that turns a
 * role's advisory connector declaration into a hard claim requirement.
 *
 * A task may only require connectors its role actually declares in
 * `connectorRefs`; otherwise the task would be permanently unclaimable, since
 * the claim route can never satisfy a connector the role never mounts.
 *
 * The role lookup MUST be team-scoped. Team-wide role rows carry
 * `workspaceId IS NULL`, and role slugs are seeded per team (`builder`,
 * `researcher`, `organizer` exist in every team), so a slug-only lookup can
 * resolve another team's row — accepting a connector id this team's role does
 * not declare, or rejecting one it does. The claim route's own pre-filter is
 * team-scoped for the same reason.
 */

export type RequiredConnectorsResult =
  | { ok: true; value: string[] | null }
  | { ok: false; error: string };

/**
 * Effective `connectorRefs` for a role in one workspace, by the claim route's
 * precedence (@buildd/core/role-visibility): workspace override > the
 * requester's own personal role > a shared personal role > team default.
 * Another member's private role is never read — its refs are not what the
 * task's claim would mount.
 */
export async function resolveRoleConnectorRefs(
  roleSlug: string,
  workspaceId: string,
  teamId: string,
  requesterUserId: string | null = null,
): Promise<string[]> {
  const roleRows = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.slug, roleSlug),
      eq(workspaceSkills.enabled, true),
      eq(workspaceSkills.teamId, teamId),
      or(eq(workspaceSkills.workspaceId, workspaceId), isNull(workspaceSkills.workspaceId)),
      personalRoleVisibleSql(requesterUserId),
    ),
    columns: { ...ROLE_VISIBILITY_COLUMNS, connectorRefs: true },
  });
  const roleRow = pickVisibleRoleRow(roleRows, roleSlug, { teamId, workspaceId, requesterUserId });
  return (roleRow?.connectorRefs as string[] | null) ?? [];
}

/**
 * Validates a caller-supplied `requiredConnectors` value.
 *
 * `undefined` means "not supplied" and is only meaningful to the caller, so pass
 * it only when you intend a no-op — the result is `{ ok: true, value: null }`.
 */
export async function validateRequiredConnectors(
  raw: unknown,
  ctx: { roleSlug: string | null; workspaceId: string; teamId: string | null; requesterUserId?: string | null },
): Promise<RequiredConnectorsResult> {
  if (raw === undefined || raw === null) return { ok: true, value: null };

  if (!Array.isArray(raw) || !raw.every((id: unknown) => typeof id === 'string')) {
    return { ok: false, error: 'requiredConnectors must be an array of connector ID strings' };
  }
  const ids = raw as string[];
  if (ids.length === 0) return { ok: true, value: ids };

  if (!ctx.roleSlug) {
    return { ok: false, error: 'requiredConnectors requires a roleSlug on the task' };
  }
  if (!ctx.teamId) {
    return { ok: false, error: 'requiredConnectors requires the workspace to belong to a team' };
  }

  const refs = await resolveRoleConnectorRefs(ctx.roleSlug, ctx.workspaceId, ctx.teamId, ctx.requesterUserId ?? null);
  const invalid = ids.filter((id) => !refs.includes(id));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `requiredConnectors contains IDs not in the role's connectorRefs: ${invalid.join(', ')}`,
    };
  }
  return { ok: true, value: ids };
}
