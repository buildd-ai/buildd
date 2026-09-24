import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workerErrorTraces } from '@buildd/core/db/schema';
import { eq, and, desc, gt } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { resolveTaskIdForCaller } from '@/lib/resolve-task-id';

// GET /api/tasks/[id]/error-traces?since=<ISO>&limit=<n>
//
// Returns error traces across all workers that have run on this task. Useful
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
  const apiAccount = await authenticateApiKey(apiKey);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const canAccess = async (workspaceId: string): Promise<boolean> =>
    apiAccount && !user
      ? verifyAccountWorkspaceAccess(apiAccount.id, workspaceId)
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
    columns: { id: true, workspaceId: true },
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

  return NextResponse.json({
    traces,
    count: traces.length,
    taskId: id,
    ...(resolved.resolvedFrom ? { resolvedFrom: resolved.resolvedFrom } : {}),
  });
}
