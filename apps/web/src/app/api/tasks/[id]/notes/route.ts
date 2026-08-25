import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missionNotes, tasks, workspaces } from '@buildd/core/db/schema';
import { eq, and, isNull, asc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import { channels, events, triggerEvent } from '@/lib/pusher';
import type { MissionNoteAuthorType, MissionNoteStatus, MissionNoteType } from '@buildd/shared';

const VALID_TYPES: MissionNoteType[] = ['decision', 'question', 'warning', 'suggestion', 'update'];
const VALID_AUTHOR_TYPES: MissionNoteAuthorType[] = ['agent', 'user', 'system'];
const VALID_STATUSES: MissionNoteStatus[] = ['open', 'answered', 'dismissed'];

async function resolveTaskAccess(id: string, user: Awaited<ReturnType<typeof getCurrentUser>>, apiAccount: { id: string } | null) {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    columns: { id: true, workspaceId: true, missionId: true },
  });
  if (!task) return null;
  const hasAccess = user
    ? await verifyWorkspaceAccess(user.id, task.workspaceId)
    : await verifyAccountWorkspaceAccess(apiAccount!.id, task.workspaceId);
  if (!hasAccess) return null;
  return task;
}

// GET /api/tasks/[id]/notes — fetch task-scoped notes (task not linked to a mission)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const task = await resolveTaskAccess(id, user, apiAccount);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const notes = await db.query.missionNotes.findMany({
    where: and(eq(missionNotes.taskId, id), isNull(missionNotes.missionId)),
    orderBy: [asc(missionNotes.createdAt)],
    limit: 100,
  });

  return NextResponse.json({ notes });
}

// POST /api/tasks/[id]/notes — post a note for a task that is not linked to a mission
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const task = await resolveTaskAccess(id, user, apiAccount);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  if (task.missionId) {
    return NextResponse.json(
      { error: 'Task is linked to a mission; post the note to its mission feed' },
      { status: 409 },
    );
  }

  const body = await req.json();
  const { type, title, bodyText, workerId, authorType, defaultChoice, status } = body;
  if (!type || !VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` }, { status: 400 });
  }
  if (!title || typeof title !== 'string') {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }

  const effectiveAuthorType: MissionNoteAuthorType =
    authorType && VALID_AUTHOR_TYPES.includes(authorType)
      ? authorType
      : (apiAccount ? 'agent' : 'user');
  const effectiveStatus: MissionNoteStatus =
    status && VALID_STATUSES.includes(status)
      ? status
      : (type === 'question' ? 'open' : 'answered');

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, task.workspaceId),
    columns: { dataClass: true },
  });
  const effectiveBody =
    workspace?.dataClass === 'sensitive' && effectiveAuthorType === 'agent'
      ? null
      : (bodyText || null);

  const [note] = await db.insert(missionNotes).values({
    missionId: null,
    taskId: id,
    workerId: workerId || null,
    authorType: effectiveAuthorType,
    type,
    title,
    body: effectiveBody,
    defaultChoice: defaultChoice || null,
    status: effectiveStatus,
  }).returning();

  await triggerEvent(channels.task(id), events.MISSION_NOTE_POSTED, {
    noteId: note.id,
    type: note.type,
    authorType: note.authorType,
    title: note.title,
  });

  return NextResponse.json(note, { status: 201 });
}
