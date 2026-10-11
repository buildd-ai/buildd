/**
 * A role a caller names on a task (create or edit) must be one the task may
 * run under (@buildd/core/role-visibility): naming another member's private
 * role is refused with `role_not_visible` rather than silently filed or saved
 * role-less. Shared personal roles and team roles pass; so does a slug no row
 * backs at all (that is the claim's problem, as it always was).
 *
 * One gate for POST /api/tasks and PATCH /api/tasks/[id], so an edit cannot
 * reach a role creation refuses.
 */
import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  pickVisibleRoleRow,
  ROLE_VISIBILITY_COLUMNS,
  roleRowsInScope,
  slugHasPersonalRows,
} from '@buildd/core/role-visibility';

export type StatedRoleRow = Pick<typeof workspaceSkills.$inferSelect,
  'id' | 'slug' | 'workspaceId' | 'teamId' | 'ownerUserId' | 'visibility' | 'enabled' | 'defaultBackend'>;

export interface StatedRoleRefusal {
  error: string;
  gateReason: 'role_not_visible';
}

export interface StatedRoleCheck {
  /** Every in-scope row for the slug (empty when no slug or no team). */
  rows: StatedRoleRow[];
  /** Set when the slug names only rows this task may not use; answer 400 with it. */
  refused: StatedRoleRefusal | null;
}

export async function checkStatedRole(
  roleSlug: string | null | undefined,
  ctx: {
    teamId: string | null | undefined;
    workspaceId: string;
    /** Who the task is for; called only when a personal row for the slug exists. */
    requesterUserId: () => Promise<string | null>;
  },
): Promise<StatedRoleCheck> {
  if (!roleSlug || !ctx.teamId) return { rows: [], refused: null };
  const rows: StatedRoleRow[] = await db.query.workspaceSkills.findMany({
    where: and(
      roleRowsInScope({ teamId: ctx.teamId, workspaceId: ctx.workspaceId }),
      eq(workspaceSkills.slug, roleSlug),
      eq(workspaceSkills.isRole, true),
    ),
    columns: { ...ROLE_VISIBILITY_COLUMNS, enabled: true, defaultBackend: true },
  });
  if (rows.length === 0) return { rows, refused: null };
  const visible = pickVisibleRoleRow(rows, roleSlug, {
    teamId: ctx.teamId,
    workspaceId: ctx.workspaceId,
    requesterUserId: slugHasPersonalRows(rows, roleSlug) ? await ctx.requesterUserId() : null,
  });
  if (visible) return { rows, refused: null };
  return {
    rows,
    refused: {
      error: `Role '${roleSlug}' is a private role of another team member; only its owner's tasks can use it`,
      gateReason: 'role_not_visible',
    },
  };
}
