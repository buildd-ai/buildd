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
import { LIVE_WORKER_STATUSES, OPEN_TASK_STATUSES, isOpenTaskStatus } from '@buildd/shared';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { requeueBranchContext } from '@/lib/integration-refresh';
import { withoutForceClaim } from '@/lib/force-claim';
import { releaseAndNotify } from '@/lib/path-claim-release';
import { notDeliveryOwnedTaskSql } from '@/lib/workflow/pr-fact-scope';
import { START_ANYWAY_PARK_KEY, parkAllowed, parseAssessment, planPark, type AssessmentFields } from '@buildd/core/start-anyway';
import { wakeTask } from '@/lib/dispatch-authority';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { lastStartAnyway, START_ANYWAY_PARKS_KEY } from '@/lib/start-anyway';
import { isUuid } from '@/lib/uuid';

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
  if (typeof taskId !== 'string' || !isUuid(taskId)) {
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
  /**
   * Set for a task a person started anyway (spec 36df686b): its assessment's
   * park is the sanctioned wait, so the workspace flag does not gate it. The
   * budget stops a dead prerequisite from looping wake and re-park.
   */
  startAnyway?: { parks: number } | null;
}): WaitExitDecision {
  const refuse = (status: number, code: string, error: string): WaitExitRefusal => ({ ok: false, status, code, error });
  if (i.startAnyway && !parkAllowed(i.startAnyway.parks)) {
    return refuse(409, 'park_limit', `This task has already parked on a prerequisite ${i.startAnyway.parks} times. Do not park again: finish what can be done, or ask a person.`);
  }
  if (!i.enabled && !i.startAnyway) {
    return refuse(409, 'wait_exit_disabled', 'Waiting on another task is not turned on for this workspace. Finish with complete_task { error } naming the task you are blocked by, or ask a person.');
  }
  if (!isOpenTaskStatus(i.task.status)) {
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
  | {
      ok: true; taskId: string; blocker: { id: string; title: string }; dependsOn: string[]; workerId: string | null;
      /** A Start anyway park: whether the recheck after the write found it already released and woke it (R-9). */
      park?: { resumedOnRecheck: boolean };
    }
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
  /** A Start anyway park's structured assessment (optional; malformed is refused). */
  assessment?: unknown;
}): Promise<WaitExitResult> {
  let assessment: AssessmentFields | null = null;
  if (i.assessment !== undefined && i.assessment !== null) {
    const parsed = parseAssessment(i.assessment);
    if (!parsed.ok) return { ok: false, status: 400, code: 'invalid_assessment', error: parsed.error };
    assessment = parsed.assessment;
  }
  const blocker = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, i.blockerTaskId)),
    columns: { id: true, workspaceId: true, status: true, loopState: true, title: true, updatedAt: true },
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
  const startedAnyway = lastStartAnyway((i.task.context ?? null) as Record<string, unknown> | null);
  const parks = Number((i.task.context as Record<string, unknown> | null)?.[START_ANYWAY_PARKS_KEY] ?? 0) || 0;
  const decision = decideWaitExit({
    enabled: waitExitEnabled(i.task.gitConfig),
    startAnyway: startedAnyway ? { parks } : null,
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
  const now = new Date();
  const record: WaitExitRecord = { blockerTaskId: blocker!.id, reason: i.reason, workerId, at: now.toISOString() };
  // R-8: a Start anyway park keeps its assessment and the exact wake condition:
  // the prerequisite, the event, and the version of it this park observed.
  const park = startedAnyway
    ? planPark({
        assessment: assessment ?? { needs: i.reason, canProceed: 'unknown', uncertainty: 'unknown', nextStep: `wait for "${blocker!.title}" to merge` },
        prerequisite: { id: blocker!.id, title: blocker!.title, status: blocker!.status, version: blocker!.updatedAt ? new Date(blocker!.updatedAt).getTime() : 0 },
      })
    : null;

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
        ...(startedAnyway ? { [START_ANYWAY_PARKS_KEY]: parks + 1 } : {}),
        ...(park ? { [START_ANYWAY_PARK_KEY]: { ...park.persist, structured: !!assessment, at: record.at } } : {}),
      },
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, i.task.id), inArray(tasks.status, [...OPEN_TASK_STATUSES]), notDeliveryOwnedTaskSql()))
    .returning({ id: tasks.id });
  if (!moved) return { ok: false, status: 409, code: 'not_open', error: 'The task finished or was cancelled while the wait was being recorded.' };

  if (workerId) {
    await db.update(workers)
      .set({ status: 'completed', completedAt: new Date(), waitingFor: null, updatedAt: new Date() })
      .where(and(eq(workers.id, workerId), inArray(workers.status, [...LIVE_WORKER_STATUSES])));
  }
  // Its paths are no longer being worked on; a task waiting on them may go.
  await releaseAndNotify(i.task.id, 'abandoned');

  // Subscribe-and-recheck (R-9). The dependency wake fires when the
  // prerequisite is released; if that happened while this task was still
  // running (a merge, an early release), the wake saw no pending dependent
  // and this park would strand. So read the claim's own gate once more now the
  // task is pending, and wake it if it already passes.
  let resumedOnRecheck = false;
  if (park) {
    const ready = await db.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.id, i.task.id), eq(tasks.status, 'pending'), depsGate()));
    if (ready.length > 0) {
      await wakeTask(i.task.id, 'dependency.satisfied', { metadata: { startAnyway: 'park_recheck' } });
      resumedOnRecheck = true;
    }
  }

  return {
    ok: true, taskId: i.task.id, blocker: { id: blocker!.id, title: blocker!.title }, dependsOn: decision.dependsOn, workerId,
    ...(park ? { park: { resumedOnRecheck } } : {}),
  };
}
