import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { requestingPerson } from '@/lib/request-person';
import { kernelPrincipalOf } from '@/lib/workflow/kernel-client';
import { applyTaskCancelSideEffects } from '@/lib/task-cancel';
import { sqlWhere } from '@buildd/core/db/relational-sql';

const ANSWERS = ['in_scope', 'amend_scope', 'out_of_scope'] as const;
type Answer = (typeof ANSWERS)[number];

const REFUSED: Record<string, { status: number; error: string }> = {
  no_decision: { status: 409, error: 'This task is not waiting on a scope decision.' },
  not_in_mission: { status: 409, error: 'This task is no longer in that mission.' },
  not_found: { status: 404, error: 'Task not found' },
  invalid_answer: { status: 400, error: `answer must be one of ${ANSWERS.join(', ')}` },
};

/**
 * POST /api/tasks/[id]/scope-answer
 *
 * Answer the held scope decision of a task added to a mission
 * (docs/specs/workflow-kernel-library.md §6 "Scope amendments"). Body:
 * `{ answer: 'in_scope' | 'amend_scope' | 'out_of_scope' }`:
 *  - `in_scope`: it fits the mission as written; the task is released;
 *  - `amend_scope`: it changes the mission; the amendment is applied (even one
 *    that removes or loosens a check: that is what the person was asked) and
 *    the task is released;
 *  - `out_of_scope`: it belongs elsewhere; the task is cancelled.
 * Recorded once through the kernel (`mission_scope_resolve`); answering again
 * reads the first answer back. Person-only, like every decision a hold asks a
 * person for: an API key or per-task token is refused.
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

  const body = await req.json().catch(() => null) as { answer?: unknown } | null;
  const answer = body?.answer;
  if (typeof answer !== 'string' || !(ANSWERS as readonly string[]).includes(answer)) {
    return NextResponse.json(REFUSED.invalid_answer, { status: 400 });
  }
  const person = requestingPerson(user, apiAccount);
  if (!person) {
    return NextResponse.json({
      error: 'Only a person can answer whether a task changes what its mission delivers: ask the owner, or use an interactive (OAuth) session.',
    }, { status: 403 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: sqlWhere(eq(tasks.id, id)),
      columns: { id: true, workspaceId: true, missionId: true },
    });
    const hasAccess = task && (apiAccount
      ? await verifyAccountWorkspaceAccess(apiAccount, task.workspaceId)
      : await verifyWorkspaceAccess(user!.id, task.workspaceId));
    if (!task || !hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    if (!task.missionId) return NextResponse.json(REFUSED.not_in_mission, { status: 409 });

    const { answerMissionTaskScope } = await import('@/lib/mission-epoch-door');
    const result = await answerMissionTaskScope({
      taskId: task.id, workspaceId: task.workspaceId, missionId: task.missionId, answer: answer as Answer,
      actor: `human:${person}`, principal: kernelPrincipalOf({ person, account: apiAccount }),
    });
    if (!result.resolved) {
      const r = REFUSED[result.reason] ?? { status: 409, error: result.reason };
      return NextResponse.json({ error: r.error, reason: result.reason }, { status: r.status });
    }
    if (result.cancelled) await applyTaskCancelSideEffects({ id: task.id, workspaceId: task.workspaceId, missionId: task.missionId });
    return NextResponse.json({
      ok: true, resolution: result.resolution, scopeVersion: result.scopeVersion, replayed: result.replayed, cancelled: result.cancelled,
    });
  } catch (error) {
    console.error('Task scope answer error:', error);
    return NextResponse.json({ error: 'Failed to record the answer' }, { status: 500 });
  }
}
