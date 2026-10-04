import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { missionNotes, missions, workspaces } from '@buildd/core/db/schema';
import { eq, desc, and, lt } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import {
  authenticateTaskScopedCaller, taskScopeAllowsMission, taskScopeAllowsTask, taskScopeAllowsWorkerId,
  type TaskScopedAccount,
} from '@/lib/task-token-auth';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { isUuid } from '@/lib/uuid';
import { wakeMissionAfterResponse } from '@/lib/mission-wake';
import type { MissionNoteType, MissionNoteAuthorType, MissionNoteStatus } from '@buildd/shared';
import { workspaceOpenToCaller } from '@/lib/open-workspaces';

function invalidUuid(label: string, value: string, status: 400 | 404) {
  return NextResponse.json(
    { error: `Invalid ${label}: expected a UUID, got "${value}". Pass the full UUID.` },
    { status },
  );
}

const VALID_TYPES: MissionNoteType[] = ['decision', 'question', 'warning', 'suggestion', 'update', 'reply', 'guidance'];
const VALID_AUTHOR_TYPES: MissionNoteAuthorType[] = ['agent', 'user', 'system', 'mcp'];
const VALID_STATUSES: MissionNoteStatus[] = ['open', 'answered', 'dismissed'];

function bearer(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  return authHeader?.replace('Bearer ', '') || null;
}

/**
 * `apiAccount` is authenticated by the handler. A per-task token (POST only)
 * has already been confined to its own task's mission, which stands in for
 * the admin gate an account key must pass here.
 */
async function resolveMissionAccess(req: NextRequest, missionId: string, apiAccount: TaskScopedAccount | null) {
  const user = await getCurrentUser();

  if (!user && !apiAccount) return null;

  if (apiAccount && !apiAccount.taskScope && !hasTokenRouteAdminAccess(apiAccount, req, req.method === 'GET' ? 'tasks:read' : undefined)) return null;

  const teamIds = await resolveAccountTeamIds(user, apiAccount);

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, teamId: true, workspaceId: true },
  });

  if (!mission) return null;

  // Check team access or open workspace
  if (teamIds.includes(mission.teamId)) return { mission, user, apiAccount };
  if (mission.workspaceId) {
    if (await workspaceOpenToCaller(mission.workspaceId, { teamIds, accountId: apiAccount?.id })) return { mission, user, apiAccount };
  }

  return null;
}

// GET /api/missions/[id]/notes — paginated feed, newest first
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return invalidUuid('mission id', id, 404);
  }
  const access = await resolveMissionAccess(req, id, await authenticateApiKey(bearer(req), req));
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const cursor = url.searchParams.get('cursor'); // noteId for cursor-based pagination
  const typeFilter = url.searchParams.get('type');

  if (cursor && !isUuid(cursor)) {
    return invalidUuid('cursor', cursor, 400);
  }

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
  if (!isUuid(id)) {
    return invalidUuid('mission id', id, 404);
  }
  // A per-task token may post only to its own task's mission feed.
  const apiAccount = await authenticateTaskScopedCaller(bearer(req), req);
  if (apiAccount && !(await taskScopeAllowsMission(apiAccount, id))) {
    return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
  }
  const access = await resolveMissionAccess(req, id, apiAccount);
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
    // A task token pins a note only to its own task and worker: the worker is
    // whose next check-in receives the reply.
    if (apiAccount && taskId && !taskScopeAllowsTask(apiAccount, taskId)) {
      return NextResponse.json({ error: 'A task token may pin a note only to its own task' }, { status: 403 });
    }
    if (apiAccount && !(await taskScopeAllowsWorkerId(apiAccount, workerId))) {
      return NextResponse.json({ error: 'A task token may attribute a note only to its own worker' }, { status: 403 });
    }

    const effectiveAuthorType: MissionNoteAuthorType = authorType && VALID_AUTHOR_TYPES.includes(authorType)
      ? authorType
      : (access.apiAccount ? 'agent' : 'user');

    const effectiveStatus: MissionNoteStatus = status && VALID_STATUSES.includes(status)
      ? status
      : (type === 'question' ? 'open' : 'answered');

    // Sensitive: agent-authored notes store type+title only, drop body prose
    let isSensitive = false;
    if (access.mission.workspaceId) {
      const wsRow = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, access.mission.workspaceId),
        columns: { dataClass: true },
      });
      isSensitive = wsRow?.dataClass === 'sensitive';
    }
    const effectiveBody = (isSensitive && effectiveAuthorType === 'agent') ? null : (bodyText || null);

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
      body: effectiveBody,
      replyTo: replyTo || null,
      defaultChoice: defaultChoice || null,
      status: effectiveStatus,
    }).returning();

    // Trigger real-time event — on the task channel too when the note is pinned
    // to a task, where the task page's question feed listens.
    const payload = {
      noteId: note.id,
      type: note.type,
      authorType: note.authorType,
      title: note.title,
    };
    await triggerEvent(channels.mission(id), events.MISSION_NOTE_POSTED, payload);
    if (note.taskId) {
      await triggerEvent(channels.task(note.taskId), events.MISSION_NOTE_POSTED, payload);
    }

    // A person writing to the mission is steering it: plan the next step now
    // rather than on the next heartbeat. Only a signed-in user's note — agent,
    // MCP and system notes are the platform talking to itself, and waking on
    // them would let an organizer's own note re-plan the mission. Keyed on the
    // session, not only on authorType: an API-key caller may pass
    // authorType='user' in the body.
    if (note.authorType === 'user' && access.user && !access.apiAccount) {
      wakeMissionAfterResponse(id, note.replyTo ? 'owner_answer' : 'owner_note');
    }

    return NextResponse.json(note, { status: 201 });
  } catch (error) {
    console.error('Create mission note error:', error);
    return NextResponse.json({ error: 'Failed to create note' }, { status: 500 });
  }
}
