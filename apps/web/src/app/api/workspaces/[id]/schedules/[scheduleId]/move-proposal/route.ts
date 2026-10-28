import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { taskSchedules, tasks, workspaces } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from '@/lib/team-access';
import { taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { getOpenMoveProposal, listScheduleMoves, MOVE_REASON_MAX, recordMoveProposal, validateScheduleMove } from '@/lib/schedule-move';
import { isUuid } from '@/lib/uuid';


type RouteParams = { params: Promise<{ id: string; scheduleId: string }> };

// GET - the schedule's open move proposal (for its banner) and its move history.
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id, scheduleId } = await params;
  const user = await getCurrentUser();
  let allowed = !!user && !!(await verifyWorkspaceAccess(user.id, id));
  if (!allowed) {
    const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
    const account = await authenticateTaskScopedCaller(apiKey, req);
    allowed = !!account && (!account.taskScope || account.taskScope.workspaceId === id) && await verifyAccountWorkspaceAccess(account, id);
  }
  if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const schedule = await db.query.taskSchedules.findFirst({
    where: sqlWhere(and(eq(taskSchedules.id, scheduleId), eq(taskSchedules.workspaceId, id))),
    columns: { id: true },
  });
  if (!schedule) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  const [proposal, history] = await Promise.all([getOpenMoveProposal(scheduleId), listScheduleMoves(scheduleId)]);
  return NextResponse.json({ proposal, history });
}

// POST - a task this schedule spawned proposes that future runs start in another
// workspace. Changes nothing but the one open proposal; a person accepts it.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id, scheduleId } = await params;
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Only a run the schedule spawned may propose (AC-15): a task token whose task carries this schedule.
  const scope = account.taskScope;
  if (!scope || !taskScopeAllowsWorkspace(account, id)) {
    return NextResponse.json({ error: 'Only a task spawned by this schedule can propose moving it' }, { status: 403 });
  }
  const [task] = await db.select({ scheduleId: tasks.scheduleId }).from(tasks).where(eq(tasks.id, scope.taskId)).limit(1);
  if (!task?.scheduleId || task.scheduleId !== scheduleId) {
    return NextResponse.json({ error: 'Only a task spawned by this schedule can propose moving it' }, { status: 403 });
  }
  const schedule = await db.query.taskSchedules.findFirst({ where: sqlWhere(eq(taskSchedules.id, scheduleId)) });
  if (!schedule?.workspaceId) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  if (schedule.workspaceId !== id) {
    return NextResponse.json({ error: 'The schedule has already moved out of this workspace' }, { status: 409 });
  }

  const body = await req.json().catch(() => null) as { workspace?: unknown; reason?: unknown; evidence?: unknown } | null;
  const target = typeof body?.workspace === 'string' ? body.workspace.trim() : '';
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!target) return NextResponse.json({ error: 'workspace is required' }, { status: 400 });
  if (!reason) return NextResponse.json({ error: 'reason is required' }, { status: 400 });
  if (reason.length > MOVE_REASON_MAX) return NextResponse.json({ error: `reason must be at most ${MOVE_REASON_MAX} characters` }, { status: 400 });

  // The proposer only names a workspace of the team; whether the person who
  // accepts can create there is checked when they accept.
  // The target is an id, or a name or owner/repo of exactly one workspace of the schedule's team
  // (a task token's own workspace list would not show the very workspace it wants to move to).
  let targetId = target;
  if (!isUuid(target as unknown)) {
    const [home] = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, id)).limit(1);
    const teamWorkspaces = home ? await db.select({ id: workspaces.id, name: workspaces.name, repo: workspaces.repo }).from(workspaces).where(eq(workspaces.teamId, home.teamId)) : [];
    const wanted = target.toLowerCase();
    const matches = teamWorkspaces.filter(w => w.name.toLowerCase() === wanted || (w.repo ?? '').toLowerCase() === wanted);
    if (matches.length > 1) return NextResponse.json({ error: `"${target}" names more than one workspace; pass the workspace id` }, { status: 400 });
    if (matches.length === 0) return NextResponse.json({ error: 'Target workspace not found' }, { status: 404 });
    targetId = matches[0]!.id;
  }

  const check = await validateScheduleMove({ fromWorkspaceId: id, targetWorkspaceId: targetId, canCreateIn: async () => true });
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const evidence = typeof body?.evidence === 'string' && body.evidence.trim()
    ? { note: body.evidence.trim().slice(0, MOVE_REASON_MAX) }
    : null;
  const proposal = await recordMoveProposal({
    schedule, targetWorkspaceId: targetId, reason, origin: 'task', taskId: scope.taskId,
    evidence,
  });
  return NextResponse.json({ proposal }, { status: 201 });
}
