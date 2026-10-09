/**
 * Which role slugs are effective for one workspace — the per-task resolution
 * knowledge-base: buildd/design/role-routing.md §3.1 prescribes, the same scoping
 * `checkConnectorRouting` uses: rows of the workspace's team whose
 * `workspaceId` is NULL (team default) or this workspace (override), keyed by
 * slug, the workspace row winning — plus personal roles, by the shared rule
 * in @buildd/core/role-visibility: shared ones always, a private one only when
 * the task is for its owner (`requesterUserId`). With no requester a private
 * role is never effective, so system-filed work cannot pick one up.
 *
 * Used where code sets a role on a task it creates from a slug something else
 * wrote earlier (a plan step, a schedule template). A slug that no longer
 * resolves here names no persona and would strand the task at claim, so the
 * caller files it role-less instead.
 */

import { db } from '@buildd/core/db';
import { workspaces, workspaceSkills } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  effectiveVisibleRoles,
  ROLE_VISIBILITY_COLUMNS,
  roleRowsVisibleTo,
  type RoleVisibilityContext,
  type VisibleRoleRow,
} from '@buildd/core/role-visibility';

export interface RoleScopeRow extends VisibleRoleRow {
  enabled: boolean | null;
}

/**
 * Pure: the effective rows — one per slug by role-visibility precedence
 * (override > own personal > shared personal > team default), then dropping
 * a winner that is disabled (an override can disable a team role).
 */
export function effectiveRoleRows<T extends RoleScopeRow>(rows: T[], ctx: RoleVisibilityContext): T[] {
  return effectiveVisibleRoles(rows, ctx).filter(r => r.enabled !== false);
}

/** Pure: effective slugs from the team-default, override and personal rows of one workspace. */
export function effectiveRoleSlugs(rows: RoleScopeRow[], ctx: RoleVisibilityContext): Set<string> {
  return new Set(effectiveRoleRows(rows, ctx).map(r => r.slug));
}

export interface EffectiveRole {
  slug: string;
  name: string;
  color: string;
}

/**
 * The roles a task in `workspaceId` may carry, for a picker (name and colour
 * from the winning row). Empty when the workspace is unknown.
 */
export async function resolveEffectiveRoles(
  workspaceId: string,
  requesterUserId: string | null = null,
): Promise<EffectiveRole[]> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  if (!ws?.teamId) return [];

  const rows = await db.query.workspaceSkills.findMany({
    where: and(
      roleRowsVisibleTo({ teamId: ws.teamId, workspaceId, requesterUserId }),
      eq(workspaceSkills.isRole, true),
    ),
    columns: { ...ROLE_VISIBILITY_COLUMNS, enabled: true, name: true, color: true },
  });
  return effectiveRoleRows(rows, { teamId: ws.teamId, workspaceId, requesterUserId })
    .map(r => ({ slug: r.slug, name: r.name ?? r.slug, color: r.color ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The role slugs a task in `workspaceId` may carry. Empty when the workspace is unknown. */
export async function resolveEffectiveRoleSlugs(
  workspaceId: string,
  requesterUserId: string | null = null,
): Promise<Set<string>> {
  return new Set((await resolveEffectiveRoles(workspaceId, requesterUserId)).map(r => r.slug));
}

/**
 * The first of `candidates` that is an effective role in `workspaceId`, else
 * null — how a pipeline that knows what it is dispatching sets a constant or
 * pass-through role (role-routing §1 row 9). Blank candidates are skipped, so
 * a caller can pass an optional pass-through slug ahead of its constant.
 *
 * Never throws: a role lookup is not worth failing a filing over, and a task
 * filed role-less is exactly what the caller got before this existed.
 */
export async function pickEffectiveRole(
  workspaceId: string,
  candidates: ReadonlyArray<string | null | undefined>,
  opts: { requesterUserId?: string | null } = {},
): Promise<string | null> {
  const wanted = candidates.filter((c): c is string => typeof c === 'string' && c.length > 0);
  if (wanted.length === 0) return null;
  try {
    const known = await resolveEffectiveRoleSlugs(workspaceId, opts.requesterUserId ?? null);
    return wanted.find(slug => known.has(slug)) ?? null;
  } catch (err) {
    console.warn(`[effective-roles] role lookup failed for workspace ${workspaceId}; filing role-less:`, err);
    return null;
  }
}
