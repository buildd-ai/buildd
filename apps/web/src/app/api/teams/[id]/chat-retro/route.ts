/**
 * /api/teams/[id]/chat-retro — the team's chat retro opt-in, and its recent
 * lessons (experiment; apps/web/src/lib/chat-retro/, removal in its REMOVAL.md).
 *
 * GET   → { settings: { lessons, proposals }, globallyEnabled, lessons: [...] }
 * PATCH { lessons?: boolean, proposals?: boolean } → { settings, deletedLessons }
 *
 * Admins only, both ways: a signed-in owner or admin of the team, or an
 * admin-level API key belonging to the team. Lessons are labels and counts,
 * never message text. Turning lessons off deletes every lesson the team has.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teamMembers } from '@buildd/core/db/schema';
import { getRequestPrincipal } from '@/lib/auth-helpers';
import { isUuid } from '@/lib/uuid';
import { applyChatRetroPatch, chatRetroGloballyEnabled } from '@/lib/chat-retro/settings';
import { deleteTeamLessons, listRecentLessons, readTeamSettings, writeTeamSettings } from '@/lib/chat-retro/store';

/** Null when allowed, else the response to send. */
async function requireTeamAdmin(req: NextRequest, teamId: string): Promise<NextResponse | null> {
  if (!isUuid(teamId)) {
    return NextResponse.json({ error: `Invalid team id: expected a UUID, got "${teamId}".` }, { status: 404 });
  }
  const principal = await getRequestPrincipal(req);
  if (!principal) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (principal.kind === 'api_key') {
    if (principal.account.teamId !== teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    if (principal.account.level !== 'admin') {
      return NextResponse.json({ error: 'Chat retro settings need an admin-level API key' }, { status: 403 });
    }
    return null;
  }
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, principal.user.id)),
    columns: { role: true },
  });
  if (!membership) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return NextResponse.json({ error: 'Only a team owner or admin can see or change chat retro settings' }, { status: 403 });
  }
  return null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await requireTeamAdmin(req, id);
  if (denied) return denied;
  try {
    const [settings, lessons] = await Promise.all([readTeamSettings(id), listRecentLessons(id)]);
    return NextResponse.json({ settings, globallyEnabled: chatRetroGloballyEnabled(), lessons });
  } catch (error) {
    console.error('Get chat retro settings error:', error);
    return NextResponse.json({ error: 'Failed to read chat retro settings' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await requireTeamAdmin(req, id);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  try {
    const current = await readTeamSettings(id);
    const patch = applyChatRetroPatch(current, body);
    if (!patch.ok) return NextResponse.json({ error: patch.error }, { status: 400 });
    await writeTeamSettings(id, patch.next);
    const deletedLessons = patch.deleteLessons ? await deleteTeamLessons(id) : 0;
    return NextResponse.json({ settings: patch.next, deletedLessons });
  } catch (error) {
    console.error('Update chat retro settings error:', error);
    return NextResponse.json({ error: 'Failed to update chat retro settings' }, { status: 500 });
  }
}
