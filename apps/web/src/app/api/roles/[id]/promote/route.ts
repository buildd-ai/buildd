import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isUuid } from '@/lib/uuid';
import { can } from '@/lib/permissions';
import { RUNNER_PROVIDED_ENV, findSharedSlugClash, findVisibleTeamLevelRole, isPersonalRole, sharedSlugClashBody, isSharedSlugViolation } from '@/lib/personal-roles';

/**
 * POST /api/roles/[id]/promote
 *
 * Turn a shared personal role into a team role (owner cleared), keeping its
 * slug. Needs `manage_agent_roles` in the role's team. A private role must be
 * shared first, so the owner has agreed the team may use it.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid role id: expected a UUID, got "${id}".` }, { status: 404 });
  }
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const role = await findVisibleTeamLevelRole(id, user.id);
    if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    if (!isPersonalRole(role)) {
      return NextResponse.json({ error: 'This is already a team role' }, { status: 400 });
    }
    if (!(await can({ kind: 'user', userId: user.id }, 'manage_agent_roles', role.teamId))) {
      return NextResponse.json({ error: 'Managing agent roles requires team admin' }, { status: 403 });
    }
    if (role.visibility !== 'team') {
      return NextResponse.json({ error: 'Share this role with the team before promoting it' }, { status: 409 });
    }

    const clash = await findSharedSlugClash({ teamId: role.teamId, slug: role.slug, excludeId: role.id });
    if (clash) return NextResponse.json(sharedSlugClashBody(clash), { status: 409 });

    const [updated] = await db
      .update(workspaceSkills)
      .set({ ownerUserId: null, visibility: 'team', updatedAt: new Date() })
      .where(and(eq(workspaceSkills.id, role.id), isNotNull(workspaceSkills.ownerUserId)))
      .returning();
    if (!updated) return NextResponse.json({ error: 'Role not found' }, { status: 404 });

    // The owner's personal secrets do not follow the role to the team: say
    // which env vars now need a team secret instead of failing at claim.
    const envVars = Object.keys((updated.requiredEnvVars as Record<string, string> | null) ?? {}).filter(e => !RUNNER_PROVIDED_ENV.has(e));
    return NextResponse.json({
      skill: updated,
      ...(envVars.length > 0
        ? { warnings: [`requiredEnvVars ${envVars.join(', ')} were mapped to the previous owner's secrets; map them to team secrets.`] }
        : {}),
    });
  } catch (error) {
    if (isSharedSlugViolation(error)) {
      return NextResponse.json({ error: 'The team already has a shared or team role with this slug. Rename this role before sharing it.' }, { status: 409 });
    }
    console.error('POST /api/roles/[id]/promote error:', error);
    return NextResponse.json({ error: 'Failed to promote role' }, { status: 500 });
  }
}
