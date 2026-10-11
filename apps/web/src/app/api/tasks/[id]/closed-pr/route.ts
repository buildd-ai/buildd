import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { desc, eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { requestingPerson } from '@/lib/request-person';
import { recordPrAbandonment } from '@/lib/pr-supersession';

/**
 * POST /api/tasks/[id]/closed-pr
 *
 * Mark a task's closed-unmerged PR abandoned: the work is deliberately not
 * shipping. Body: `{ action: 'abandon', reason }`.
 *
 * The task-scoped twin of `POST /api/missions/[id]/closed-prs`, for a task
 * with no mission (that route requires `task.missionId` to match). Same write
 * (`recordPrAbandonment`) and the same person-only rule (T21,
 * docs/specs/workflow-state-kernel.md): a dashboard session or the person's
 * own OAuth session may; an API key or per-task token is refused.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid task id: expected a UUID, got "${id}".` }, { status: 404 });
  }

  const user = await getCurrentUser();
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const apiAccount = await authenticateApiKey(apiKey, req);
  if (!user && !apiAccount) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (apiAccount && !hasTokenRouteAdminAccess(apiAccount, req)) {
    return NextResponse.json({ error: 'Requires admin-level API key' }, { status: 403 });
  }
  const person = requestingPerson(user, apiAccount);

  const body = await req.json().catch(() => null) as { action?: unknown; reason?: unknown } | null;
  if (body?.action !== 'abandon') {
    return NextResponse.json({ error: 'action must be "abandon"' }, { status: 400 });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return NextResponse.json({ error: 'A reason is required to mark a PR abandoned' }, { status: 400 });
  }
  if (!person) {
    return NextResponse.json({
      error: 'Only a person can mark a PR abandoned: ask the owner, or use an interactive (OAuth) session.',
    }, { status: 403 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, id),
      columns: { id: true, workspaceId: true },
      with: {
        workers: {
          columns: { id: true, prUrl: true },
          orderBy: [desc(workers.startedAt)],
          limit: 1,
        },
      },
    });
    const hasAccess = task && (apiAccount
      ? await verifyAccountWorkspaceAccess(apiAccount, task.workspaceId)
      : await verifyWorkspaceAccess(user!.id, task.workspaceId));
    if (!task || !hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    const worker = task.workers?.[0];
    if (!worker?.prUrl) return NextResponse.json({ error: 'Task has no PR' }, { status: 404 });

    const recordedBy = user?.email ?? apiAccount?.name ?? 'unknown';
    const result = await recordPrAbandonment({ workerId: worker.id, reason, recordedBy, actor: `human:${person}` });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, action: 'abandon' });
  } catch (error) {
    console.error('Task closed PR abandon error:', error);
    return NextResponse.json({ error: 'Failed to record the decision' }, { status: 500 });
  }
}
