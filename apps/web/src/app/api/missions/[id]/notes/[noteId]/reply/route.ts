import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missionNotes, missions, workspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { triggerEvent, channels, events } from '@/lib/pusher';

// POST /api/missions/[id]/notes/[noteId]/reply — reply to a specific note
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; noteId: string }> }
) {
  const { id, noteId } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }

  // Resolve team access
  let teamIds: string[] = [];
  if (apiAccount) {
    teamIds = [apiAccount.teamId];
  } else if (user) {
    teamIds = await getUserTeamIds(user.id);
  }

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, id),
    columns: { id: true, teamId: true, workspaceId: true },
  });

  if (!mission) {
    return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
  }

  let hasAccess = teamIds.includes(mission.teamId);
  if (!hasAccess && mission.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, mission.workspaceId),
      columns: { accessMode: true },
    });
    if (ws?.accessMode === 'open') hasAccess = true;
  }
  if (!hasAccess) {
    return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
  }

  try {
    // Verify the parent note exists and belongs to this mission
    const parentNote = await db.query.missionNotes.findFirst({
      where: and(
        eq(missionNotes.id, noteId),
        eq(missionNotes.missionId, id),
      ),
    });

    if (!parentNote) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 });
    }

    const body = await req.json();
    const { title, bodyText } = body;

    if (!title || typeof title !== 'string') {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    // Mark parent note as answered
    await db.update(missionNotes)
      .set({ status: 'answered' })
      .where(eq(missionNotes.id, noteId));

    // Create the reply note
    const [reply] = await db.insert(missionNotes).values({
      missionId: id,
      authorType: apiAccount ? 'agent' : 'user',
      type: 'reply',
      title,
      body: bodyText || null,
      replyTo: noteId,
      status: 'answered',
    }).returning();

    // Trigger real-time event
    await triggerEvent(channels.mission(id), events.MISSION_NOTE_POSTED, {
      noteId: reply.id,
      type: 'reply',
      authorType: reply.authorType,
      title: reply.title,
      replyTo: noteId,
    });

    return NextResponse.json(reply, { status: 201 });
  } catch (error) {
    console.error('Reply to mission note error:', error);
    return NextResponse.json({ error: 'Failed to create reply' }, { status: 500 });
  }
}
