import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { resolveRolesCaller } from '@/lib/roles-caller';
import { isUuid } from '@/lib/uuid';
import {
  findSharedSlugClash, findVisibleTeamLevelRole, isPersonalRole, mayEditPersonalRole, sharedSlugClashBody, isSharedSlugViolation,
} from '@/lib/personal-roles';

/**
 * POST /api/roles/[id]/share — { visibility: 'team' | 'private' }
 *
 * Share a personal role with the whole team, or take it back to private. Its
 * owner may, and so may a `manage_agent_roles` holder once it is shared.
 * Sharing is refused (409) when a team role or another shared personal role
 * in the team already uses the slug. No approval step.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid role id: expected a UUID, got "${id}".` }, { status: 404 });
  }
  // A dashboard session, or an OAuth MCP session's bearer (lib/roles-caller.ts).
  const who = await resolveRolesCaller(req);
  if (!who.ok) return who.response;
  const user = { id: who.caller.userId };

  try {
    const body = await req.json().catch(() => ({}));
    const visibility = body?.visibility;
    if (visibility !== 'team' && visibility !== 'private') {
      return NextResponse.json({ error: "visibility must be 'team' or 'private'", field: 'visibility' }, { status: 400 });
    }

    const found = await findVisibleTeamLevelRole(id, user.id);
    const role = found && (who.caller.bearerTeamId === null || found.teamId === who.caller.bearerTeamId) ? found : undefined;
    if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    if (!isPersonalRole(role)) {
      return NextResponse.json({ error: 'Team roles are always shared with the team; only a personal role has a visibility' }, { status: 400 });
    }
    if (!(await mayEditPersonalRole(user.id, role))) {
      return NextResponse.json({ error: 'Only the role owner or a team admin can change who uses this role' }, { status: 403 });
    }
    if (role.visibility === visibility) return NextResponse.json({ skill: role });

    if (visibility === 'team') {
      const clash = await findSharedSlugClash({ teamId: role.teamId, slug: role.slug, excludeId: role.id });
      if (clash) return NextResponse.json(sharedSlugClashBody(clash), { status: 409 });
    }

    const [updated] = await db
      .update(workspaceSkills)
      .set({ visibility, updatedAt: new Date() })
      .where(and(eq(workspaceSkills.id, role.id), isNotNull(workspaceSkills.ownerUserId)))
      .returning();
    if (!updated) return NextResponse.json({ error: 'Role not found' }, { status: 404 });

    return NextResponse.json({ skill: updated });
  } catch (error) {
    if (isSharedSlugViolation(error)) {
      return NextResponse.json({ error: 'The team already has a shared or team role with this slug. Rename this role before sharing it.' }, { status: 409 });
    }
    console.error('POST /api/roles/[id]/share error:', error);
    return NextResponse.json({ error: 'Failed to change role visibility' }, { status: 500 });
  }
}
