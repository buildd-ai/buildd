/**
 * /api/teams/[id]/chat-retro — the team's chat retro opt-in, and its recent
 * lessons (experiment; apps/web/src/lib/chat-retro/, removal in its REMOVAL.md).
 *
 * GET   → { settings: { lessons, proposals }, dogfood, canActivateDogfood, globallyEnabled, lessons: [...] }
 * PATCH { lessons?: boolean, proposals?: boolean } → { settings, deletedLessons }
 * POST  { accountDogfood: true } → { settings, dogfood: true, syncedTeamIds }
 *
 * GET and PATCH: a signed-in owner or admin of the team, or an admin-level
 * API key belonging to the team. Lessons are labels and counts, never message
 * text. Turning lessons off deletes every lesson the team has.
 *
 * `settings` is effective: while an owner of the team has account dogfood on
 * (`dogfood: true`) it is lessons + proposals whatever is stored, and a PATCH
 * that would turn either off is a 409 that changes and deletes nothing.
 *
 * POST turns account dogfood on for the signed-in person, and backfills every
 * team they own. Only a team owner, in their own session: it is a choice about
 * all of that person's teams, so no API key and no admin can make it for them.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teamMembers } from '@buildd/core/db/schema';
import { getRequestPrincipal } from '@/lib/auth-helpers';
import { isUuid } from '@/lib/uuid';
import { keyLevelHas, roleHas, getTeamPermissionOverrides } from '@/lib/permissions';
import { applyChatRetroPatch, chatRetroGloballyEnabled } from '@/lib/chat-retro/settings';
import {
  activateAccountDogfood, deleteTeamLessons, hasAccountDogfood, listRecentLessons, readTeamRetroState, writeTeamSettings,
} from '@/lib/chat-retro/store';

/** Who is allowed (`userId`/`role` are null for an API key), else the response to send. */
async function requireTeamAdmin(req: NextRequest, teamId: string): Promise<NextResponse | { userId: string | null; role: string | null }> {
  if (!isUuid(teamId)) {
    return NextResponse.json({ error: `Invalid team id: expected a UUID, got "${teamId}".` }, { status: 404 });
  }
  const principal = await getRequestPrincipal(req);
  if (!principal) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (principal.kind === 'api_key') {
    if (principal.account.teamId !== teamId) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    if (!keyLevelHas(principal.account.level, 'manage_chat_retro')) {
      return NextResponse.json({ error: 'Chat retro settings need an admin-level API key' }, { status: 403 });
    }
    return { userId: null, role: null };
  }
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, principal.user.id)),
    columns: { role: true },
  });
  if (!membership) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  if (!roleHas(membership.role, 'manage_chat_retro', await getTeamPermissionOverrides(teamId))) {
    return NextResponse.json({ error: 'Only a team owner or admin can see or change chat retro settings' }, { status: 403 });
  }
  return { userId: principal.user.id, role: membership.role };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireTeamAdmin(req, id);
  if (auth instanceof NextResponse) return auth;
  const { userId, role } = auth;
  try {
    const [state, lessons, ownDogfood] = await Promise.all([
      readTeamRetroState(id),
      listRecentLessons(id),
      userId && roleHas(role, 'activate_chat_retro_dogfood', null /* locked */) ? hasAccountDogfood(userId) : Promise.resolve(true),
    ]);
    return NextResponse.json({
      settings: state.settings,
      dogfood: state.dogfood,
      canActivateDogfood: !ownDogfood,
      globallyEnabled: chatRetroGloballyEnabled(),
      lessons,
    });
  } catch (error) {
    console.error('Get chat retro settings error:', error);
    return NextResponse.json({ error: 'Failed to read chat retro settings' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireTeamAdmin(req, id);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  try {
    const { settings: current, dogfood } = await readTeamRetroState(id);
    const patch = applyChatRetroPatch(current, body, { dogfood });
    if (!patch.ok) {
      return NextResponse.json(
        { error: patch.error, ...(patch.locked ? { dogfood: true, settings: current } : {}) },
        { status: patch.locked ? 409 : 400 },
      );
    }
    await writeTeamSettings(id, patch.next);
    const deletedLessons = patch.deleteLessons ? await deleteTeamLessons(id) : 0;
    return NextResponse.json({ settings: patch.next, deletedLessons });
  } catch (error) {
    console.error('Update chat retro settings error:', error);
    return NextResponse.json({ error: 'Failed to update chat retro settings' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireTeamAdmin(req, id);
  if (auth instanceof NextResponse) return auth;
  const { userId, role } = auth;
  if (!userId || !roleHas(role, 'activate_chat_retro_dogfood', null /* locked */)) {
    return NextResponse.json(
      { error: 'Account dogfood covers every team you own, so only a team owner can turn it on, signed in as themselves' },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || (body as Record<string, unknown>).accountDogfood !== true) {
    return NextResponse.json({ error: 'Body must be { "accountDogfood": true }' }, { status: 400 });
  }
  try {
    const { syncedTeamIds } = await activateAccountDogfood(userId);
    const state = await readTeamRetroState(id);
    return NextResponse.json({ settings: state.settings, dogfood: state.dogfood, syncedTeamIds });
  } catch (error) {
    console.error('Activate chat retro account dogfood error:', error);
    return NextResponse.json({ error: 'Failed to turn on account dogfood' }, { status: 500 });
  }
}
