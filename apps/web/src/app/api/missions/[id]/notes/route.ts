import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missionNotes, missions, workspaces } from '@buildd/core/db/schema';
import { eq, desc, and, lt } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { triggerEvent, channels, events } from '@/lib/pusher';
import type { MissionNoteType, MissionNoteAuthorType, MissionNoteStatus } from '@buildd/shared';

const VALID_TYPES: MissionNoteType[] = ['decision', 'question', 'warning', 'suggestion', 'update', 'reply', 'guidance'];
const VALID_AUTHOR_TYPES: MissionNoteAuthorType[] = ['agent', 'user', 'system'];
const VALID_STATUSES: MissionNoteStatus[] = ['open', 'answered', 'dismissed'];

async function resolveMissionAccess(req: NextRequest, missionId: string) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) return null;

  if (apiAccount && apiAccount.level !== 'admin') return null;

  const teamIds = await resolveAccountTeamIds(user, apiAccount);

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, teamId: true, workspaceId: true },
  });

  if (!mission) return null;

  // Check team access or open workspace
  if (teamIds.includes(mission.teamId)) return { mission, user, apiAccount };
  if (mission.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, mission.workspaceId),
      columns: { accessMode: true },
    });
    if (ws?.accessMode === 'open') return { mission, user, apiAccount };
  }

  return null;
}

// GET /api/missions/[id]/notes — paginated feed, newest first
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await resolveMissionAccess(req, id);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const cursor = url.searchParams.get('cursor'); // noteId for cursor-based pagination
  const typeFilter = url.searchParams.get('type');

  try {
    const conditions = [eq(missionNotes.missionId, id)];

    if (cursor) {
      // Fetch the cursor note's createdAt for offset
      const cursorNote = await db.query.missionNotes.findFirst({
        where: eq(missionNotes.id, cursor),
        columns: { createdAt: true },
      });
      if (cursorNote) {
        conditions.push(lt(missionNotes.createdAt, cursorNote.createdAt));
      }
    }

    if (typeFilter && VALID_TYPES.includes(typeFilter as MissionNoteType)) {
      conditions.push(eq(missionNotes.type, typeFilter as MissionNoteType));
    }

    const notes = await db.query.missionNotes.findMany({
      where: and(...conditions),
      orderBy: [desc(missionNotes.createdAt)],
      limit: limit + 1, // fetch one extra to determine hasMore
    });

    const hasMore = notes.length > limit;
    const results = hasMore ? notes.slice(0, limit) : notes;
    const nextCursor = hasMore ? results[results.length - 1]?.id : null;

    return NextResponse.json({
      notes: results,
      nextCursor,
      hasMore,
    });
  } catch (error) {
    console.error('Get mission notes error:', error);
    return NextResponse.json({ error: 'Failed to fetch notes' }, { status: 500 });
  }
}

// POST /api/missions/[id]/notes — post a note (user guidance/reply or agent note)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await resolveMissionAccess(req, id);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { type, title, bodyText, taskId, workerId, authorType, replyTo, defaultChoice, status } = body;

    if (!type || !VALID_TYPES.includes(type)) {
      return NextResponse.json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` }, { status: 400 });
    }
    if (!title || typeof title !== 'string') {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const effectiveAuthorType: MissionNoteAuthorType = authorType && VALID_AUTHOR_TYPES.includes(authorType)
      ? authorType
      : (access.apiAccount ? 'agent' : 'user');

    const effectiveStatus: MissionNoteStatus = status && VALID_STATUSES.includes(status)
      ? status
      : (type === 'question' ? 'open' : 'answered');

    // If this is a reply, mark the parent note as answered
    if (replyTo) {
      await db.update(missionNotes)
        .set({ status: 'answered' })
        .where(and(
          eq(missionNotes.id, replyTo),
          eq(missionNotes.missionId, id),
        ));
    }

    const [note] = await db.insert(missionNotes).values({
      missionId: id,
      taskId: taskId || null,
      workerId: workerId || null,
      authorType: effectiveAuthorType,
      type,
      title,
      body: bodyText || null,
      replyTo: replyTo || null,
      defaultChoice: defaultChoice || null,
      status: effectiveStatus,
    }).returning();

    // Trigger real-time event
    await triggerEvent(channels.mission(id), events.MISSION_NOTE_POSTED, {
      noteId: note.id,
      type: note.type,
      authorType: note.authorType,
      title: note.title,
    });

    return NextResponse.json(note, { status: 201 });
  } catch (error) {
    console.error('Create mission note error:', error);
    return NextResponse.json({ error: 'Failed to create note' }, { status: 500 });
  }
}
