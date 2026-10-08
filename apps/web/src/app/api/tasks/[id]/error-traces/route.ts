import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workerErrorTraces } from '@buildd/core/db/schema';
import { eq, and, desc, gt } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { resolveTaskIdForCaller } from '@/lib/resolve-task-id';

// GET /api/tasks/[id]/error-traces?since=<ISO>&limit=<n>
//
// Returns error traces across all workers that have run on this task, plus the
// task's `result.evidence` / `result.mismatch` (why it ended as it did). Useful
// for the task-detail UI (single badge with cumulative count) and for agents
// retrying a task to see what the previous attempt failed on.
//
// `id` may be an 8+ character prefix (the form the UI and KB memories cite).
// It resolves only within workspaces the caller can access; the response then
// carries `resolvedFrom`. Ambiguous prefixes return 409 with the candidates.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await params;

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token reads traces of any task in its own task's workspace;
  // canAccess confines prefix resolution and the task read alike.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const canAccess = async (workspaceId: string): Promise<boolean> =>
    apiAccount && !user
      ? taskScopeAllowsWorkspace(apiAccount, workspaceId) && verifyAccountWorkspaceAccess(apiAccount.id, workspaceId)
      : !!(await verifyWorkspaceAccess(user!.id, workspaceId));

  const resolved = await resolveTaskIdForCaller(rawId, canAccess);
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.error, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
      { status: resolved.status },
    );
  }
  const id = resolved.id;

  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    columns: { id: true, workspaceId: true, status: true, result: true },
  });
  if (!task || !(await canAccess(task.workspaceId))) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const sinceParam = req.nextUrl.searchParams.get('since');
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(limitParam || '100', 10) || 100, 1), 500);

  const conds = [eq(workerErrorTraces.taskId, id)];
  if (sinceParam) {
    const since = new Date(sinceParam);
    if (!isNaN(since.getTime())) conds.push(gt(workerErrorTraces.ts, since));
  }

  const traces = await db.query.workerErrorTraces.findMany({
    where: and(...conds),
    orderBy: [desc(workerErrorTraces.ts)],
    limit,
  });

  // The compact record written when the task ended (see lib/task-evidence.ts).
  // Same reach as the traces: it is only read after `canAccess` on the task's
  // workspace above, so it needs no guard of its own.
  const result = (task.result ?? null) as { evidence?: unknown; mismatch?: unknown } | null;

  return NextResponse.json({
    traces,
    count: traces.length,
    taskId: id,
    status: task.status ?? null,
    evidence: result?.evidence ?? null,
    mismatch: Array.isArray(result?.mismatch) ? result.mismatch : [],
    ...(resolved.resolvedFrom ? { resolvedFrom: resolved.resolvedFrom } : {}),
  });
}
