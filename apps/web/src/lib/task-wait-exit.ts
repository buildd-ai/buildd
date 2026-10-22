/**
 * The wait exit (Living Spec d25d923d R-20, AC-12): an agent that finds
 * mid-run that another task holds it ends its run by waiting on that task
 * instead of failing. The blocker joins the task's `dependsOn`, the task goes
 * back to `pending` with the reason recorded, and the existing dependency wake
 * (`checkDependsOnResolved` → `enqueueReadyDependents`) restarts it when the
 * blocker merges. No person retries it into the same wall.
 *
 * Behind a per-workspace flag (`gitConfig.waitOnTask`). Validated here, never
 * trusted from the agent: the blocker is a real task in the same workspace,
 * not the task itself, not already merged or cancelled, and the new edge makes
 * no cycle (PATCH `dependsOn` checks self-dependency only).
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, desc } from 'drizzle-orm';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { requeueBranchContext } from '@/lib/integration-refresh';
import { withoutForceClaim } from '@/lib/force-claim';
import { releaseAndNotify } from '@/lib/path-claim-release';

/** The task context key the exit records: who waits on what, and why. */
export const WAIT_EXIT_CONTEXT_KEY = 'waitExit';

export interface WaitExitRecord {
  blockerTaskId: string;
  reason: string;
  workerId: string | null;
  at: string;
}

/** A dependency walk this deep is a modelling error, not a plan. */
const MAX_WALK = 500;
const MAX_REASON = 2000;

export interface WaitExitTaskRow {
  id: string;
  workspaceId: string;
  status: string;
  dependsOn: string[] | null;
  /** A live kernel delivery owns this task's status; the exit does not move it. */
  deliveryId?: string | null;
}

export interface WaitExitBlockerRow {
  id: string;
  workspaceId: string;
  status: string;
  loopState?: string | null;
  title: string;
}

export type WaitExitRefusal = { ok: false; status: number; code: string; error: string };
export type WaitExitDecision = { ok: true; dependsOn: string[] } | WaitExitRefusal;

/** The workspace flag that turns the exit on. Off unless set to true. */
export function waitExitEnabled(gitConfig: unknown): boolean {
  return !!gitConfig && typeof gitConfig === 'object' && (gitConfig as { waitOnTask?: unknown }).waitOnTask === true;
}

/** Parse the `waitOn` body: `{ taskId, reason }`. */
export function parseWaitOn(raw: unknown): { ok: true; blockerTaskId: string; reason: string } | WaitExitRefusal {
  const bad = (error: string): WaitExitRefusal => ({ ok: false, status: 400, code: 'invalid_wait', error });
  if (!raw || typeof raw !== 'object') return bad('waitOn must be { taskId, reason }');
  const { taskId, reason } = raw as { taskId?: unknown; reason?: unknown };
  if (typeof taskId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
    return bad('waitOn.taskId must be the full UUID of the task you are waiting on');
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    return bad('waitOn.reason is required: say what you need from that task, for the person reading this one');
  }
  return { ok: true, blockerTaskId: taskId, reason: reason.trim().slice(0, MAX_REASON) };
}

/**
 * Whether adding `taskId → blockerId` closes a cycle: true when `taskId` is
 * reachable from `blockerId` over existing `dependsOn` edges. `edges` holds
 * every task the walk visits.
 */
export function wouldCycle(taskId: string, blockerId: string, edges: ReadonlyMap<string, readonly string[]>): boolean {
  if (taskId === blockerId) return true;
  const seen = new Set<string>();
  const stack = [blockerId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of edges.get(id) ?? []) if (!seen.has(next)) stack.push(next);
  }
  return false;
}

/** The pure decision: everything read, nothing written. */
export function decideWaitExit(i: {
  enabled: boolean;
  task: WaitExitTaskRow;
  blockerTaskId: string;
  blocker: WaitExitBlockerRow | null;
  /** The blocker's latest PR is still open (it is completed but not merged). */
  blockerHasOpenPr: boolean;
  edges: ReadonlyMap<string, readonly string[]>;
}): WaitExitDecision {
  const refuse = (status: number, code: string, error: string): WaitExitRefusal => ({ ok: false, status, code, error });
  if (!i.enabled) {
    return refuse(409, 'wait_exit_disabled', 'Waiting on another task is not turned on for this workspace. Finish with complete_task { error } naming the task you are blocked by, or ask a person.');
  }
  if (!['pending', 'assigned', 'in_progress'].includes(i.task.status)) {
    return refuse(409, 'not_open', `This task is ${i.task.status}; only an open task can wait on another.`);
  }
  if (i.task.deliveryId) {
    return refuse(409, 'delivery_owned', 'A delivery owns this task\'s status (its PR is in review or landing), so it cannot be moved back to wait. Finish normally or ask a person.');
  }
  if (i.blockerTaskId === i.task.id) return refuse(400, 'self', 'A task cannot wait on itself.');
  const b = i.blocker;
  if (!b || b.workspaceId !== i.task.workspaceId) {
    return refuse(404, 'unknown_blocker', `No task ${i.blockerTaskId} in this workspace. Name the task you are waiting on by its full id.`);
  }
  if (b.status === 'cancelled') {
    return refuse(409, 'blocker_cancelled', `"${b.title}" was cancelled, so it will never merge. Do not wait on it; finish with complete_task { error } or ask a person.`);
  }
  const merged = b.status === 'completed' && !i.blockerHasOpenPr && (b.loopState == null || b.loopState === 'satisfied');
  if (merged) {
    return refuse(409, 'blocker_merged', `"${b.title}" has already merged. Pull its change and carry on; there is nothing to wait for.`);
  }
  if (wouldCycle(i.task.id, b.id, i.edges)) {
    return refuse(409, 'cycle', `"${b.title}" already waits on this task (directly or through others). Waiting on it would hold both forever; ask a person instead.`);
  }
  const current = i.task.dependsOn ?? [];
  return { ok: true, dependsOn: current.includes(b.id) ? current : [...current, b.id] };
}

/** Every `dependsOn` edge reachable from `start`, one query per level. */
async function loadDependencyEdges(start: string, workspaceId: string): Promise<Map<string, string[]>> {
  const edges = new Map<string, string[]>();
  let frontier = [start];
  while (frontier.length > 0 && edges.size < MAX_WALK) {
    const rows = await db.query.tasks.findMany({
      where: sqlWhere(and(inArray(tasks.id, frontier), eq(tasks.workspaceId, workspaceId))),
      columns: { id: true, dependsOn: true },
    });
    const next: string[] = [];
    for (const r of rows) {
      const deps = (r.dependsOn as string[] | null) ?? [];
      edges.set(r.id, deps);
      for (const d of deps) if (!edges.has(d)) next.push(d);
    }
    // Ids the query did not return (other workspaces, deleted) end the walk there.
    for (const id of frontier) if (!edges.has(id)) edges.set(id, []);
    frontier = [...new Set(next)];
  }
  return edges;
}

export type WaitExitResult =
  | { ok: true; taskId: string; blocker: { id: string; title: string }; dependsOn: string[]; workerId: string | null }
  | WaitExitRefusal;

/**
 * Apply the exit: validate, move the task back to `pending` waiting on the
 * blocker, and end the live worker's run as completed (it did what it could;
 * a wait is not a failure and spends no retry). The next run resumes on the
 * worker's branch.
 */
export async function applyWaitExit(i: {
  task: WaitExitTaskRow & { context: unknown; gitConfig: unknown };
  blockerTaskId: string;
  reason: string;
  /** The worker asking, when known; otherwise the task's live worker. */
  workerId?: string | null;
}): Promise<WaitExitResult> {
  const blocker = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, i.blockerTaskId)),
    columns: { id: true, workspaceId: true, status: true, loopState: true, title: true },
  });
  let blockerHasOpenPr = false;
  if (blocker?.status === 'completed') {
    const latestPr = await db.query.workers.findFirst({
      where: sqlWhere(and(eq(workers.taskId, blocker.id), isNotNull(workers.prUrl))),
      columns: { mergedAt: true },
      orderBy: sqlOrderBy([desc(workers.createdAt)]),
    });
    blockerHasOpenPr = !!latestPr && !latestPr.mergedAt;
  }
  const edges = blocker && blocker.workspaceId === i.task.workspaceId
    ? await loadDependencyEdges(blocker.id, i.task.workspaceId)
    : new Map<string, string[]>();
  const decision = decideWaitExit({
    enabled: waitExitEnabled(i.task.gitConfig),
    task: i.task,
    blockerTaskId: i.blockerTaskId,
    blocker: blocker ?? null,
    blockerHasOpenPr,
    edges,
  });
  if (!decision.ok) return decision;

  const liveWorker = await db.query.workers.findFirst({
    where: sqlWhere(and(
      eq(workers.taskId, i.task.id),
      inArray(workers.status, [...LIVE_WORKER_STATUSES]),
      ...(i.workerId ? [eq(workers.id, i.workerId)] : []),
    )),
    columns: { id: true, branch: true },
  });
  const workerId = liveWorker?.id ?? null;
  const ctx = (i.task.context ?? {}) as Record<string, unknown>;
  const record: WaitExitRecord = { blockerTaskId: blocker!.id, reason: i.reason, workerId, at: new Date().toISOString() };

  const [moved] = await db.update(tasks)
    .set({
      status: 'pending',
      dependsOn: decision.dependsOn,
      claimedBy: null,
      claimedAt: null,
      expiresAt: null,
      context: {
        ...withoutForceClaim(ctx),
        ...requeueBranchContext(ctx, liveWorker?.branch),
        [WAIT_EXIT_CONTEXT_KEY]: record,
      },
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, i.task.id), inArray(tasks.status, ['pending', 'assigned', 'in_progress'])))
    .returning({ id: tasks.id });
  if (!moved) return { ok: false, status: 409, code: 'not_open', error: 'The task finished or was cancelled while the wait was being recorded.' };

  if (workerId) {
    await db.update(workers)
      .set({ status: 'completed', completedAt: new Date(), waitingFor: null, updatedAt: new Date() })
      .where(and(eq(workers.id, workerId), inArray(workers.status, [...LIVE_WORKER_STATUSES])));
  }
  // Its paths are no longer being worked on; a task waiting on them may go.
  await releaseAndNotify(i.task.id, 'abandoned');

  return { ok: true, taskId: i.task.id, blocker: { id: blocker!.id, title: blocker!.title }, dependsOn: decision.dependsOn, workerId };
}
