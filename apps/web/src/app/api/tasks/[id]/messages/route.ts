import { hasTokenRouteAdminAccess } from '@/lib/token-route-policy';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { desc, eq, sql } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateTaskScopedCaller, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { verifyWorkspaceAccess, verifyAccountWorkspaceAccess, holdsInWorkspace } from '@/lib/team-access';
import { isUuid } from '@/lib/uuid';
import { messageDeliveryStatus, type InstructionHistoryEntry } from '@/lib/worker-instructions';
import { sqlExtras, sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';


// GET /api/tasks/[id]/messages - Return instruction history for the task's latest worker
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid task id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 50);
  const rawBefore = req.nextUrl.searchParams.get('before');
  const before = rawBefore === null ? undefined : Number(rawBefore);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (before !== undefined && (!Number.isSafeInteger(before) || before < 0))) {
    return NextResponse.json({ error: 'limit must be 1–100 and before a nonnegative message offset' }, { status: 400 });
  }

  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  // A per-task token reads messages only for tasks in its own task's workspace.
  const apiAccount = await authenticateTaskScopedCaller(apiKey, req);

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const task = await db.query.tasks.findFirst({
      where: sqlWhere(eq(tasks.id, id)),
      with: { workspace: true },
    });

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (user && !apiAccount) {
      const access = await verifyWorkspaceAccess(user.id, task.workspaceId);
      if (!access) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    } else if (apiAccount) {
      if (!taskScopeAllowsWorkspace(apiAccount, task.workspaceId)) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
      const hasAccess = await verifyAccountWorkspaceAccess(apiAccount, task.workspaceId);
      if (!hasAccess) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const messageCount = sql<number>`coalesce(jsonb_array_length(${workers.instructionHistory}), 0)`;
    const end = before === undefined ? messageCount : sql<number>`least(${messageCount}, ${before})`;
    const start = sql<number>`greatest(0, ${end} - ${limit})`;
    const worker = await db.query.workers.findFirst({
      where: sqlWhere(eq(workers.taskId, id)),
      orderBy: sqlOrderBy(desc(workers.createdAt)),
      columns: { id: true, status: true, runner: true },
      extras: sqlExtras({
        messageCount,
        instructionHistory: sql<InstructionHistoryEntry[]>`case when ${end} > 0 then jsonb_path_query_array(coalesce(${workers.instructionHistory}, '[]'::jsonb), format('$[%s to %s]', ${start}, ${end} - 1)::jsonpath) else '[]'::jsonb end`,
      }),
    });

    // Every human message carries its derived state (messageDeliveryStatus):
    // callers render `state`, never the stored `deliveryState`.
    const workerStatus = worker?.status ?? null;
    const messages = ((worker?.instructionHistory as InstructionHistoryEntry[] | null) ?? []).map((m) => {
      if (m.type !== 'instruction') return m;
      const status = messageDeliveryStatus(m, workerStatus);
      return { ...m, state: status.state, stateAt: status.at };
    });

    // Whether this caller may send, by the same rule POST /api/workers/[id]/instruct
    // applies, so the Steer canvas doesn't offer a composer whose every send 404s.
    const canSend = apiAccount && hasTokenRouteAdminAccess(apiAccount, req, 'workers:admin')
      ? apiAccount.teamId === task.workspace?.teamId
      : user ? await holdsInWorkspace(user.id, task.workspaceId, 'steer_workers') : false;

    return NextResponse.json({
      taskId: id,
      workerId: worker?.id ?? null,
      workerStatus,
      workerRunner: worker?.runner ?? null,
      canSend,
      messages,
      hasMore: Math.max(0, Math.min(worker?.messageCount ?? 0, before ?? Infinity) - limit) > 0,
      nextCursor: Math.max(0, Math.min(worker?.messageCount ?? 0, before ?? Infinity) - limit) || null,
    });
  } catch (error) {
    console.error('Get task messages error:', error);
    return NextResponse.json({ error: 'Failed to get task messages' }, { status: 500 });
  }
}
