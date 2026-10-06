/**
 * /api/teams/[id]/permissions — which team roles hold each named permission.
 *
 * GET → { canEdit, permissions: [{ name, description, defaultRoles, roles, locked, overridden }] }
 * PUT { overrides: { [permission]: TeamRole[] } } → same shape, after saving
 *
 * Any signed-in member may read (it explains what they can and can't do).
 * Writing needs manage_team_permissions, which is owner-only and locked, so an
 * admin can never widen their own power. PUT replaces the whole set: an entry
 * equal to the default is dropped, and `{}` resets everything. Session only —
 * no API key can read or change grants.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teamMembers, teams } from '@buildd/core/db/schema';
import { getRequestPrincipal } from '@/lib/auth-helpers';
import { isUuid } from '@/lib/uuid';
import {
  PERMISSIONS,
  LOCKED_PERMISSIONS,
  effectiveRoles,
  parseOverridesInput,
  roleHas,
  sanitizeOverrides,
  type Permission,
  type PermissionOverrides,
} from '@/lib/permission-registry';

type Ctx = { params: Promise<{ id: string }> };

/** The caller's role in the team, or the response to send. */
async function resolveMember(req: NextRequest, teamId: string): Promise<{ role: string } | NextResponse> {
  if (!isUuid(teamId)) {
    return NextResponse.json({ error: `Invalid team id: expected a UUID, got "${teamId}".` }, { status: 404 });
  }
  const principal = await getRequestPrincipal(req);
  if (!principal) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (principal.kind === 'api_key') {
    return NextResponse.json({ error: 'Team permissions are managed by signing in, not with an API key' }, { status: 403 });
  }
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, principal.user.id)),
    columns: { role: true },
  });
  if (!membership) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  return { role: membership.role };
}

/** Read straight from the row, not the per-request cache, so a PUT's response shows what it wrote. */
async function readOverrides(teamId: string): Promise<PermissionOverrides> {
  const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { permissionOverrides: true } });
  return sanitizeOverrides(team?.permissionOverrides);
}

function describeAll(role: string, overrides: PermissionOverrides) {
  const permissions = (Object.keys(PERMISSIONS) as Permission[]).map(name => {
    const def = PERMISSIONS[name];
    return {
      name,
      description: def.description,
      defaultRoles: def.defaultRoles,
      roles: effectiveRoles(name, overrides),
      locked: LOCKED_PERMISSIONS.has(name),
      overridden: overrides[name] !== undefined,
    };
  });
  return { canEdit: roleHas(role, 'manage_team_permissions', overrides), permissions };
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const member = await resolveMember(req, id);
  if (member instanceof NextResponse) return member;
  try {
    return NextResponse.json(describeAll(member.role, await readOverrides(id)));
  } catch (error) {
    console.error('Get team permissions error:', error);
    return NextResponse.json({ error: 'Failed to read team permissions' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const member = await resolveMember(req, id);
  if (member instanceof NextResponse) return member;
  try {
    if (!roleHas(member.role, 'manage_team_permissions', await readOverrides(id))) {
      return NextResponse.json({ error: 'Only a team owner can change who can do what' }, { status: 403 });
    }
    const body = await req.json().catch(() => null);
    const parsed = parseOverridesInput(body?.overrides);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const saved = await db
      .update(teams)
      .set({ permissionOverrides: parsed.overrides as Record<string, string[]>, updatedAt: new Date() })
      .where(eq(teams.id, id))
      .returning({ id: teams.id });
    if (saved.length === 0) return NextResponse.json({ error: 'Team not found' }, { status: 404 });

    return NextResponse.json(describeAll(member.role, parsed.overrides));
  } catch (error) {
    console.error('Update team permissions error:', error);
    return NextResponse.json({ error: 'Failed to update team permissions' }, { status: 500 });
  }
}
