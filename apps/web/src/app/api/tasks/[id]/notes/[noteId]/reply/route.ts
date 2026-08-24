import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missionNotes, tasks } from '@buildd/core/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import { triggerEvent, channels, events } from '@/lib/pusher';

// POST /api/tasks/[id]/notes/[noteId]/reply — reply to a question note on a task
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; noteId: string }> },
) {
  const { id, noteId } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    columns: { id: true, workspaceId: true },
  });
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const hasAccess = user
    ? await verifyWorkspaceAccess(user.id, task.workspaceId)
    : await verifyAccountWorkspaceAccess(apiAccount!.id, task.workspaceId);
  if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const parentNote = await db.query.missionNotes.findFirst({
    where: and(
      eq(missionNotes.id, noteId),
      eq(missionNotes.taskId, id),
      isNull(missionNotes.missionId),
    ),
  });
  if (!parentNote) return NextResponse.json({ error: 'Note not found' }, { status: 404 });

  const body = await req.json();
  const { title } = body;
  if (!title || typeof title !== 'string') {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  await db.update(missionNotes)
    .set({ status: 'answered' })
    .where(eq(missionNotes.id, noteId));

  const [reply] = await db.insert(missionNotes).values({
    missionId: null,
    taskId: id,
    authorType: apiAccount ? 'agent' : 'user',
    type: 'reply',
    title,
    body: null,
    replyTo: noteId,
    status: 'answered',
  }).returning();

  await triggerEvent(channels.task(id), events.MISSION_NOTE_POSTED, {
    noteId: reply.id,
    type: 'reply',
    authorType: reply.authorType,
    title: reply.title,
    replyTo: noteId,
  });

  return NextResponse.json(reply, { status: 201 });
}
