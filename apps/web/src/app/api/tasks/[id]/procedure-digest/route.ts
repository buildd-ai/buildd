import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq, asc } from 'drizzle-orm';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } from '@/lib/team-access';
import { resolveTaskIdForCaller } from '@/lib/resolve-task-id';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { buildProcedureSkeleton } from '@buildd/core/procedure-skeleton';

// GET /api/tasks/[id]/procedure-digest
//
// The ordered tool/step names the task's workers called, repeats collapsed and
// capped at 40 steps. Names only: no labels, paths, commands or transcript text.
// `id` may be an 8+ character prefix, as in the sibling error-traces route.
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
      ? taskScopeAllowsWorkspace(apiAccount, workspaceId) && verifyAccountWorkspaceAccess(apiAccount, workspaceId)
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
    where: sqlWhere(eq(tasks.id, id)),
    columns: { id: true, workspaceId: true },
  });
  if (!task || !(await canAccess(task.workspaceId))) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const rows = await db.query.workers.findMany({
    where: sqlWhere(eq(workers.taskId, id)),
    orderBy: sqlOrderBy([asc(workers.createdAt)]),
    columns: { milestones: true },
  });
  const skeleton = buildProcedureSkeleton(rows.flatMap(r => (Array.isArray(r.milestones) ? r.milestones : [])));
  return NextResponse.json({ taskId: id, ...skeleton, ...(resolved.resolvedFrom ? { resolvedFrom: resolved.resolvedFrom } : {}) });
}
