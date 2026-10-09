import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missionNotes, tasks, workspaces } from '@buildd/core/db/schema';
import { eq, asc } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { authenticateTaskScopedCaller, taskScopeAllowsTask, taskScopeAllowsWorkerId } from '@/lib/task-token-auth';
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import { channels, events, triggerEvent } from '@/lib/pusher';
import type { MissionNoteAuthorType, MissionNoteStatus, MissionNoteType } from '@buildd/shared';
import { isUuid } from '@/lib/uuid';
import { disposeQuestionNote, gatedNoteResponse } from '@/lib/note-question-disposition';
import { RECOVERABLE_BLOCKER_REPAIR } from '@/modules';

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

// GET /api/tasks/[id]/notes — every note scoped to this task. A mission task's
// notes carry its missionId too; they are still this task's, and the task page
// shows them (knowledge-base: buildd/design/mission-feed-mobile-continuity.md S6).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid task id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const task = await resolveTaskAccess(id, user, apiAccount);
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const notes = await db.query.missionNotes.findMany({
    where: eq(missionNotes.taskId, id),
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
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid task id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token may post notes only on its own task.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && !taskScopeAllowsTask(apiAccount, id)) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
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
  // The note's worker is whose next check-in receives the reply: its own only.
  if (apiAccount && !(await taskScopeAllowsWorkerId(apiAccount, workerId))) {
    return NextResponse.json({ error: 'A task token may attribute a note only to its own worker' }, { status: 403 });
  }

  // A task token speaks only as an agent: its authorType and status are
  // forced, silently, whatever the body says. A user-authored note or an
  // answered question reads as a person's word to everything downstream.
  const taskToken = !!apiAccount?.taskScope;
  const effectiveAuthorType: MissionNoteAuthorType = taskToken
    ? 'agent'
    : authorType && VALID_AUTHOR_TYPES.includes(authorType)
      ? authorType
      : (apiAccount ? 'agent' : 'user');
  const effectiveStatus: MissionNoteStatus =
    !taskToken && status && VALID_STATUSES.includes(status)
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

  // Needs You admission (lib/note-question-disposition.ts): an agent's
  // question passes the gate's deterministic half before anyone sees it.
  const gated = await disposeQuestionNote(
    { type, authorType: effectiveAuthorType, title, bodyText, defaultChoice, workspaceId: task.workspaceId, missionId: null, taskId: id, workerId: workerId || null },
    { fileRepair: RECOVERABLE_BLOCKER_REPAIR },
  );

  const [note] = await db.insert(missionNotes).values({
    missionId: null,
    taskId: id,
    workerId: workerId || null,
    authorType: effectiveAuthorType,
    type,
    title,
    body: effectiveBody,
    defaultChoice: defaultChoice || null,
    // A recovered question is settled by its repair task, not a person.
    status: gated.disposition === 'recovered' ? 'answered' : effectiveStatus,
    disposition: gated.disposition,
  }).returning();

  await triggerEvent(channels.task(id), events.MISSION_NOTE_POSTED, {
    noteId: note.id,
    type: note.type,
    authorType: note.authorType,
    title: note.title,
  });

  return NextResponse.json(gatedNoteResponse(note, gated), { status: 201 });
}
