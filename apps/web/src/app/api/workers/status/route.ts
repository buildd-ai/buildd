import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { callerOwnsWorker } from '@/lib/worker-owner';
import { isUuid } from '@/lib/uuid';
import type { WorkerStatusView, WorkerStatusesResponse } from '@buildd/shared';

/** The most workers one read may name; a runner holds far fewer live at once. */
export const WORKER_STATUS_MAX_IDS = 100;

/**
 * GET /api/workers/status?ids=<id>,<id>,…
 *
 * The status of several workers in one read (spec 3ef37387): the runner's
 * reconcile pass used to make one full GET /api/workers/[id] per live worker,
 * each reading the worker, task and workspace rows whole. This answers only
 * what reconcile reads, `status`, `error` and the task's `status`, in one
 * statement scoped to the caller's account in SQL.
 *
 *   { workers: { [id]: { status, error, task: { status } | null } }, missing: [id] }
 *
 * `workers` holds the ids the caller owns (lib/worker-owner.ts, as the single
 * GET). `missing` holds the ids no worker row has: the runner may treat those
 * as gone. An id that exists but is not the caller's is in neither, so the
 * runner leaves it alone, as it does on the single GET's 403.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const raw = (req.nextUrl.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const ids = [...new Set(raw)];
  if (ids.length === 0) return NextResponse.json({ error: 'ids is required: a comma-separated list of worker ids.' }, { status: 400 });
  if (ids.length > WORKER_STATUS_MAX_IDS) {
    return NextResponse.json({ error: `At most ${WORKER_STATUS_MAX_IDS} ids per read; received ${ids.length}.` }, { status: 400 });
  }

  // A non-UUID can never name a worker, and comparing one to the uuid column throws (22P02).
  const valid = ids.filter(isUuid);
  const missing: string[] = ids.filter(id => !isUuid(id));
  const out: Record<string, WorkerStatusView> = {};
  if (valid.length === 0) return NextResponse.json({ workers: out, missing } satisfies WorkerStatusesResponse);

  const owned = await db
    .select({
      id: workers.id,
      status: workers.status,
      error: workers.error,
      accountId: workers.accountId,
      taskId: workers.taskId,
      workspaceId: workers.workspaceId,
      claimedByUserId: workers.claimedByUserId,
      taskStatus: tasks.status,
    })
    .from(workers)
    .leftJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(
      inArray(workers.id, valid),
      eq(workers.accountId, account.id),
      ...(account.taskScope ? [eq(workers.taskId, account.taskScope.taskId)] : []),
    ));

  const returned = new Set<string>();
  for (const row of owned) {
    returned.add(row.id);
    if (!callerOwnsWorker(account, row)) continue;
    out[row.id] = { status: row.status, error: row.error ?? null, task: row.taskStatus ? { status: row.taskStatus } : null };
  }

  // Only the ids the scoped read did not return: which of them have no row at all.
  const rest = valid.filter(id => !returned.has(id));
  if (rest.length > 0) {
    const existing = await db.select({ id: workers.id }).from(workers).where(inArray(workers.id, rest));
    const found = new Set(existing.map(r => r.id));
    for (const id of rest) if (!found.has(id)) missing.push(id);
  }

  return NextResponse.json({ workers: out, missing } satisfies WorkerStatusesResponse);
}
