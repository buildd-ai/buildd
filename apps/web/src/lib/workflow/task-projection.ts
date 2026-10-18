/**
 * S4b (docs/specs/workflow-kernel-library.md §1, AC-2): the owner task of a merged delivery is a
 * projection of T17, written in the transition's own statement beside the worker rows (`w_proj`).
 *
 * `runMergedPrWork` used to flip `tasks.status` to completed after the merge, from the
 * `emit_pr_merged` effect. Now the statement does it and tells the effect what it did, so the
 * effect performs only side effects. The rule is the one the effect applied:
 *
 *  - the task is the one of the PR's first worker row (earliest `created_at`), the row the
 *    effect's post-merge work runs for;
 *  - a task already completed stays as it is (`already_completed`);
 *  - a local session (runner `mcp`) completes its own task, so the merge leaves it open, as does
 *    another open PR on the task (a stacked series: the last merge completes it) (`not_flipped`);
 *  - otherwise the task completes (`flipped`).
 *
 * Every CTE reads the delivery CTE `d`, which is empty on a CAS miss, so nothing moves unless the
 * delivery did. Postgres runs data-modifying CTEs against one snapshot: `own` and the status read
 * see the task as it was before this statement, whatever `t_proj` writes.
 */
import { sql, type SQL } from 'drizzle-orm';
import { INTERACTIVE_WORKER_RUNNER, TERMINAL_WORKER_STATUSES } from '@buildd/shared';
import { TERMINAL_PR_LIFECYCLE } from '@/lib/dep-gate-contract';
import { notKernelMergedTaskSql, prRowOfDeliverySql } from './pr-fact-scope';
import { tasks } from '@buildd/core/db/schema';

import type { MergeTaskTransition } from '@/lib/pr-merged-work';
import type { ApplyDecision } from './commands';
import { NON_RUNNER_EXECUTOR_IDS } from '@/lib/executor';

const terminal = sql.join(TERMINAL_PR_LIFECYCLE.map((s) => sql`${s}::text`), sql`, `);

/** The CTEs that complete the owner task, after `d` (the delivery row, with its repo and PR number). */
export function mergeTaskProjectionCtes(d = 'd'): SQL[] {
  const a = sql.raw(d);
  const prUrl = sql`lower('https://github.com/' || ${a}.repo_full_name || '/pull/' || ${a}.pr_number::text)`;
  return [
    // The PR's first worker row: whose task the merge's post-merge work runs for.
    sql`own AS (
  SELECT w.id, w.task_id, w.runner FROM workers w, ${a}
  WHERE ${prRowOfDeliverySql(d)}
  ORDER BY w.created_at ASC, w.id ASC
  LIMIT 1
)`,
    sql`own_task AS (
  SELECT tk.id, tk.status FROM tasks tk JOIN own ON tk.id = own.task_id
)`,
    sql`t_proj AS (
  UPDATE tasks tk SET status = 'completed', updated_at = now()
  FROM own, ${a}
  WHERE tk.id = own.task_id AND tk.status <> 'completed'
    AND own.runner IS DISTINCT FROM ${INTERACTIVE_WORKER_RUNNER}::text
    AND NOT EXISTS (
      SELECT 1 FROM workers ow
      WHERE ow.task_id = tk.id AND ow.pr_url IS NOT NULL AND ow.pr_number IS NOT NULL
        AND lower(ow.pr_url) <> ${prUrl}
        AND (ow.pr_lifecycle_status IS NULL OR ow.pr_lifecycle_status NOT IN (${terminal}))
        AND NOT EXISTS (SELECT 1 FROM workers mw WHERE mw.task_id = tk.id AND mw.pr_url = ow.pr_url AND mw.merged_at IS NOT NULL)
    )
  RETURNING tk.id
)`,
  ];
}

/**
 * The fields the statement adds to the `emit_pr_merged` effect's payload: what it did to the task
 * and the worker row it did it for, so the effect's work runs for that same row.
 */
export function mergeTaskPayloadSql(): SQL {
  return sql`jsonb_build_object(
    'taskTransition', CASE
      WHEN EXISTS (SELECT 1 FROM t_proj) THEN 'flipped'
      WHEN (SELECT status FROM own_task) = 'completed' THEN 'already_completed'
      ELSE 'not_flipped' END,
    'ownerWorkerId', (SELECT id FROM own)
  )`;
}

/** Read the statement's answer back off the effect payload; null for an effect queued before S4b. */
export function mergeTaskTransitionOf(payload: unknown): { taskTransition: MergeTaskTransition; ownerWorkerId: string | null } | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const t = p.taskTransition;
  if (t !== 'flipped' && t !== 'already_completed' && t !== 'not_flipped') return null;
  return { taskTransition: t, ownerWorkerId: typeof p.ownerWorkerId === 'string' ? p.ownerWorkerId : null };
}

/**
 * How long a finished worker row must sit unchanged before an end read from it counts while its
 * task is still open. The worker PATCH reserves the terminal worker status in its own statement and
 * only later decides on a requeue (an auto-retry to `pending`, which is no attempt end) or overrides
 * a reported `completed` to `failed` (an output-contract miss). A read between those writes would
 * send an end the PATCH is about to cover. Longer than the PATCH can run (the platform's function
 * limit), and the floor is a backstop, so the wait costs a lost end only this much delay.
 */
export const OWNER_END_SETTLE_MS = 15 * 60_000;
/**
 * Clock allowance between `tasks.claimed_at` (stamped from the web host's clock when the claim
 * request starts) and `workers.created_at` (the database's clock at the insert just after).
 */
export const CLAIM_CLOCK_SKEW_MS = 5_000;

export interface OwnerEndTask { status: string | null | undefined; claimedAt?: Date | string | null }
export interface OwnerEndWorker { status: string | null | undefined; createdAt?: Date | string | null; updatedAt?: Date | string | null }

const ms = (v: Date | string | null | undefined): number | null => {
  if (v == null) return null;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * AC-1 slice 2 (workflow-kernel-library.md §9): whether the owner attempt has ended, read from its
 * latest worker row. `forwardOwnerEnd` and the floor use this, never `tasks.status` alone, so the
 * kernel can become the task-status writer without losing an end that never arrived. A running
 * owner task holds `assigned` for its whole attempt (nothing writes `in_progress` any more), so an
 * `assigned` task whose worker finished is exactly the end to recover.
 *
 *  - `pending`: the task's own retry is queued (the worker PATCH sends no end then,
 *    `taskRetryCoversAttemptEnd`); `cancelled`: the cancel sent its own end. No end.
 *  - A live (or superseded) latest worker: no end, whatever the task row says.
 *  - `completed` / `failed` task: the PATCH has finished deciding; the worker's end counts now.
 *  - Open task (`assigned`, legacy `in_progress`): the end counts only when the latest worker row
 *    belongs to the current claim and has settled. The claim stamps `claimed_at` with `assigned`
 *    and inserts the new worker row after, so a latest worker created before `claimed_at` is the
 *    previous attempt's while the new claim is in flight. A worker row changed within
 *    `OWNER_END_SETTLE_MS` may still be covered by the PATCH that wrote it (see above).
 *
 * Answers the end's status, or null when there is none.
 */
export function ownerAttemptEndOf(task: OwnerEndTask, worker: OwnerEndWorker, now: number = Date.now()): 'completed' | 'failed' | null {
  if (task.status === 'pending' || task.status === 'cancelled') return null;
  const end = worker.status === 'completed' ? 'completed'
    : worker.status === 'failed' || worker.status === 'error' ? 'failed'
      : null;
  if (!end) return null;
  if (task.status === 'completed' || task.status === 'failed') return end;
  const claimed = ms(task.claimedAt);
  const created = ms(worker.createdAt);
  if (claimed != null && (created == null || created < claimed - CLAIM_CLOCK_SKEW_MS)) return null;
  const changed = ms(worker.updatedAt);
  if (changed == null || now - changed < OWNER_END_SETTLE_MS) return null;
  return end;
}

// ── AC-1 slice 3: the owner attempt's end projects onto its task ────────────

/**
 * The statuses an owner task holds while its attempt runs. The projection moves only these:
 * a task some other writer already settled (completed, failed, a requeue to pending, a cancel)
 * keeps what it has, so the projection can never undo a person's cancel, reopen a task T17
 * completed, or fight a requeue. `in_progress` is legacy (nothing writes it any more).
 */
export const OWNER_OPEN_STATUSES = ['assigned', 'in_progress'] as const;

/**
 * What an owner end makes of its task: `success` completes it; `failed`, `lost` and `unproven`
 * fail it. A requeue (the kernel's `WORKING` re-entry, `taskRetryBudgetLeft`) is no end: the
 * task's own retry already put it back to pending, so it projects nothing.
 */
export function ownerEndTaskStatus(evidence: { outcome?: unknown; requeue?: unknown } | null | undefined): 'completed' | 'failed' | null {
  if (!evidence || evidence.requeue === true) return null;
  if (evidence.outcome === 'success') return 'completed';
  if (evidence.outcome === 'failed' || evidence.outcome === 'lost' || evidence.outcome === 'unproven') return 'failed';
  return null;
}

const open = sql.join(OWNER_OPEN_STATUSES.map((s) => sql`${s}::text`), sql`, `);
const tkCols = { id: sql`tk.id`, workspaceId: sql`tk.workspace_id`, status: sql`tk.status` };

/**
 * The ending worker is the task's current attempt: no newer attempt row (`isAttemptRowSql`) on the
 * task, and not older than the task's `claimed_at` (a claim stamps it from the database clock
 * before inserting the new worker row, so an older row is the previous attempt's while a re-claim
 * is in flight; same rule and skew as `ownerAttemptEndOf`).
 * An end that lands late (a parked re-send, a slow door) after its task was requeued and claimed
 * again belongs to the attempt before, so it must not settle the new one. Compared as text: a
 * reaper end with no worker row names a synthetic id, which matches nothing.
 */
export function endingWorkerIsCurrentSql(workerId: string, task = 'tk'): SQL {
  const tk = sql.raw(task);
  return sql`EXISTS (SELECT 1 FROM workers ew
      WHERE ew.id::text = ${workerId}::text AND ew.task_id = ${tk}.id
        AND (${tk}.claimed_at IS NULL OR ew.created_at >= ${tk}.claimed_at - make_interval(secs => ${CLAIM_CLOCK_SKEW_MS / 1000}::double precision))
        AND NOT EXISTS (SELECT 1 FROM workers nw WHERE nw.task_id = ${tk}.id AND ${isAttemptRowSql('nw')}
          AND (nw.created_at > ew.created_at OR (nw.created_at = ew.created_at AND nw.id > ew.id))))`;
}

/**
 * AC-1 slice 5: a worker the reaper expired is the end of its owner task's attempt only when it
 * is that attempt: an attempt row itself (a placeholder no runner executed ends nothing) and the
 * task's current one (`endingWorkerIsCurrentSql`), on a task still open. `task` names the tasks
 * row in the enclosing statement (`tasks` inside a drizzle `update(tasks)`).
 */
export function reapedOwnerAttemptIsCurrentSql(workerId: string, task = 'tk'): SQL {
  const tk = sql.raw(task);
  return sql`(${tk}.status IN (${open})
    AND EXISTS (SELECT 1 FROM workers rw WHERE rw.id::text = ${workerId}::text AND ${isAttemptRowSql('rw')})
    AND ${endingWorkerIsCurrentSql(workerId, task)})`;
}

/**
 * A worker row that is an attempt: one a claim made. Placeholder rows no runner executed
 * (`NON_RUNNER_EXECUTOR_IDS`: the sibling row a second PR of a running worker gets in
 * worker-pr-slot.ts, mission and review bookkeeping rows) are never the task's current attempt.
 */
export function isAttemptRowSql(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.runner IS NULL OR ${a}.runner NOT IN (${sql.join(NON_RUNNER_EXECUTOR_IDS.map((r) => sql`${r}::text`), sql`, `)}))`;
}

/** The JS side of `isAttemptRowSql`, for a worker row already read. */
export const isAttemptRow = (w: { runner?: string | null }): boolean => !w.runner || !NON_RUNNER_EXECUTOR_IDS.includes(w.runner);

// ── AC-1 slice 7: a claim starts the owner attempt ──────────────────────────

/**
 * The claim's compare-and-set for a kernel owner task (beside `status = 'pending'`): no other
 * claim on it, by the claim query's own rule (claim-candidate-where.ts `claimFree`): unclaimed, or
 * a claim past its expiry. A kernel owner's claim stamps claimed_by / claimed_at / expires_at and
 * leaves the status to AttemptStarted, so without this a second claimer would see the task still
 * pending. Every requeue releases the claim; one a request left behind when it died expires.
 */
export function ownerClaimOpenSql(): SQL {
  return sql`(${tasks.claimedBy} IS NULL OR ${tasks.expiresAt} < now())`;
}

/** The claim a start is for, read off the decision's evidence (reducer.ts `attemptStarted`). */
function startOf(evidence: unknown): { taskId: string; claimedBy: string; claimedAt: string } | null {
  const e = (evidence ?? {}) as Record<string, unknown>;
  if (e.start !== true || typeof e.taskId !== 'string' || typeof e.claimedBy !== 'string' || typeof e.claimedAt !== 'string') return null;
  return { taskId: e.taskId, claimedBy: e.claimedBy, claimedAt: e.claimedAt };
}

/** Only the claim that won: still pending, still carrying exactly that claim, never a kernel-merged task. */
function startGuardSql(p: { taskId: string; claimedBy: string; claimedAt: string }): SQL {
  return sql`tk.id = ${p.taskId}::uuid
    AND tk.status = 'pending'
    AND tk.claimed_by::text = ${p.claimedBy}::text
    AND tk.claimed_at = ${p.claimedAt}::timestamptz
    AND ${notKernelMergedTaskSql(tkCols)}`;
}

/**
 * The `t_start` CTE (workflow-kernel-library.md §9, AC-1): AttemptStarted moves the owner task to
 * `assigned` in the transition's own statement, reading the delivery CTE `d`, so a version miss
 * writes nothing. The claim route's compare-and-set already chose the winner; this moves the task
 * only while it still carries that claim (a cancel, a requeue or a stale takeover in between keeps
 * the task where it is). Empty for every other decision.
 */
export function startTaskProjectionCtes(decision: Pick<ApplyDecision, 'command' | 'evidence'>, d = 'd'): SQL[] {
  if (decision.command !== 'AttemptStarted') return [];
  const s = startOf(decision.evidence);
  if (!s) return [];
  const a = sql.raw(d);
  return [sql`t_start AS (
  UPDATE tasks tk SET status = 'assigned', updated_at = now()
  FROM ${a}
  WHERE tk.id = (SELECT od.owner_task_id FROM workflow_deliveries od WHERE od.id = ${a}.id)
    AND ${startGuardSql(s)}
  RETURNING tk.id
)`];
}

/**
 * The same move outside a transition: for a start the reducer did not bind (the delivery moved on
 * while the task was requeued, as a loop task's next iteration is), a duplicate, or one the control
 * plane could not take or does not know. Same guard as `t_start`. Returns the task id moved, or none.
 */
export function projectAttemptStartSql(p: { deliveryId: string; taskId: string; claimedBy: string; claimedAt: string }): SQL {
  return sql`-- workflow:project_attempt_start
UPDATE tasks tk SET status = 'assigned', updated_at = now()
WHERE tk.id = ${p.taskId}::uuid
  AND EXISTS (SELECT 1 FROM workflow_deliveries od WHERE od.id = ${p.deliveryId}::uuid AND od.owner_task_id = tk.id)
  AND ${startGuardSql(p)}
RETURNING tk.id`;
}

/** The worker an end names, from its idempotency key (`end:<workerId>`, reducer.ts). */
const endingWorkerOf = (key: string): string | null => (key.startsWith('end:') ? key.slice(4) : null);

/**
 * The `t_attempt` CTE (workflow-kernel-library.md §9, AC-1): T4 for an owner sets the owner task
 * in the transition's own statement. It reads the delivery CTE `d` (empty on a CAS miss), so a
 * version miss writes nothing. Only an owner end has a task to project: the end of the attempt a
 * `WORKING` delivery is bound to (a repair's end is FIXING/REPAIRING and its task is not the
 * owner). Only for the task's current attempt (`endingWorkerIsCurrentSql`). Empty when the
 * decision projects nothing.
 */
export function attemptEndTaskProjectionCtes(decision: Pick<ApplyDecision, 'command' | 'fromState' | 'evidence' | 'idempotencyKey'> & { effects?: ApplyDecision['effects'] }, d = 'd'): SQL[] {
  if (decision.command !== 'AttemptEnded' || decision.fromState !== 'WORKING') return [];
  const ended = ownerEndTaskStatus(decision.evidence as { outcome?: unknown; requeue?: unknown });
  const workerId = endingWorkerOf(decision.idempotencyKey);
  if (!ended || !workerId) return [];
  // AC-1 slice 8: an end whose hand-off read red CI with the CI budget spent escalates the delivery
  // in the same transition; the owner task fails then, as `t_escalate` would fail it (one write per row).
  const status = escalatesCi(decision) ? 'failed' : ended;
  const a = sql.raw(d);
  return [sql`t_attempt AS (
  UPDATE tasks tk SET status = ${status}::text, updated_at = now()
  FROM ${a} JOIN workflow_deliveries od ON od.id = ${a}.id
  WHERE tk.id = od.owner_task_id
    AND tk.status IN (${open})
    AND ${endingWorkerIsCurrentSql(workerId)}
    AND ${notKernelMergedTaskSql(tkCols)}
  RETURNING tk.id
)`];
}

/**
 * The same projection outside a transition, for an owner end that applied nothing: a duplicate
 * (the ledger already has `end:<workerId>`), a stale end (the delivery moved past WORKING), an
 * end the control plane could not take, or one an older control plane applied without projecting.
 * The ledger's recorded end wins: a duplicate projects what the kernel recorded, not what was re-sent.
 * With no recorded end it projects `fallback`, the end the caller sent, so the task cannot strand
 * open. Same rules as `t_attempt`: only the delivery's owner task, only while it is still open,
 * only for the task's current attempt, never over a kernel-merged completion. Returns the status written, or null when nothing moved.
 */
export function projectOwnerEndSql(p: { deliveryId: string; taskId: string; workerId: string; fallback: 'completed' | 'failed' | null }): SQL {
  const key = `end:${p.workerId}`;
  return sql`-- workflow:project_owner_end
WITH rec AS (
  SELECT evidence FROM workflow_transitions
  WHERE delivery_id = ${p.deliveryId}::uuid AND idempotency_key = ${key}::text
  LIMIT 1
), o AS (
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM rec) THEN ${p.fallback}::text
    WHEN (SELECT (evidence->>'requeue') = 'true' FROM rec) THEN NULL
    WHEN (SELECT evidence->>'outcome' FROM rec) = 'success' THEN 'completed'
    WHEN (SELECT evidence->>'outcome' FROM rec) IN ('failed', 'lost', 'unproven') THEN 'failed'
    ELSE ${p.fallback}::text END AS status
)
UPDATE tasks tk SET status = o.status, updated_at = now()
FROM o
WHERE tk.id = ${p.taskId}::uuid AND o.status IS NOT NULL
  AND tk.status IN (${open})
  AND EXISTS (SELECT 1 FROM workflow_deliveries od WHERE od.id = ${p.deliveryId}::uuid AND od.owner_task_id = tk.id)
  AND ${endingWorkerIsCurrentSql(p.workerId)}
  AND ${notKernelMergedTaskSql(tkCols)}
RETURNING tk.status`;
}

// ── AC-1 slice 6: a requeued attempt moves its task back to the queue ───────

/**
 * Whether a worker is its task's current attempt while the task is still open: an attempt row
 * (never a placeholder no runner executed), the newest one, not older than the claim. The rule a
 * requeue's projection applies, exported so a requeue's own write of its other fields (context,
 * backend, start floor) lands under the same condition. `task` names the tasks row in the
 * enclosing statement (`tasks` inside a drizzle `update(tasks)`).
 */
export function requeueingAttemptIsCurrentSql(workerId: string, task = 'tk'): SQL {
  // The reaper's rule (AC-1 slice 5) is the same question: is this the open task's current attempt.
  return reapedOwnerAttemptIsCurrentSql(workerId, task);
}

/** The requeue the move to `pending` is for, read off the decision's evidence (reducer.ts `attemptRequeued`). */
function requeueOf(evidence: unknown): { workerId: string; attemptId: string | null } | null {
  const e = (evidence ?? {}) as Record<string, unknown>;
  if (e.requeue !== true || typeof e.workerId !== 'string') return null;
  return { workerId: e.workerId, attemptId: typeof e.attemptId === 'string' ? e.attemptId : null };
}

/** The task a requeue moves: the delivery's owner task, or the open repair attempt's own task. */
function requeuedTaskSql(attemptId: string | null, delivery: SQL): SQL {
  return attemptId
    ? sql`tk.id = (SELECT wa.task_id FROM workflow_attempts wa
        WHERE wa.id = ${attemptId}::uuid AND wa.delivery_id = ${delivery} AND wa.status IN ('queued', 'running'))`
    : sql`tk.id = (SELECT od.owner_task_id FROM workflow_deliveries od WHERE od.id = ${delivery})`;
}

/** What a requeue writes: back to the queue, with the claim released. */
const REQUEUE_SET = sql`status = 'pending', claimed_by = NULL, claimed_at = NULL, expires_at = NULL, updated_at = now()`;

/**
 * The `t_requeue` CTE (workflow-kernel-library.md §9, AC-1): AttemptRequeued moves the attempt's
 * task back to `pending` in the transition's own statement, reading the delivery CTE `d`, so a
 * version miss writes nothing. Only an open task, only while the requeuing worker is its current
 * attempt (a requeue that lands late, after the task was claimed again, belongs to the attempt
 * before), never over a kernel-merged completion. Empty for every other decision.
 */
export function requeueTaskProjectionCtes(decision: Pick<ApplyDecision, 'command' | 'evidence'>, d = 'd'): SQL[] {
  if (decision.command !== 'AttemptRequeued') return [];
  const r = requeueOf(decision.evidence);
  if (!r) return [];
  const a = sql.raw(d);
  return [sql`t_requeue AS (
  UPDATE tasks tk SET ${REQUEUE_SET}
  FROM ${a}
  WHERE ${requeuedTaskSql(r.attemptId, sql`${a}.id`)}
    AND ${requeueingAttemptIsCurrentSql(r.workerId)}
    AND ${notKernelMergedTaskSql(tkCols)}
  RETURNING tk.id
)`];
}

/**
 * The same move outside a transition, for a requeue that applied nothing: a duplicate (a parked
 * re-send), one the reducer did not bind (the delivery moved on while the task kept running, as a
 * loop task's next iteration does), one the control plane could not take, or one an older control
 * plane does not know. Same rules as `t_requeue`. Returns the task id moved, or null.
 */
export function projectRequeueSql(p: { deliveryId: string; workerId: string; taskId: string; attemptId?: string | null }): SQL {
  return sql`-- workflow:project_requeue
UPDATE tasks tk SET ${REQUEUE_SET}
WHERE tk.id = ${p.taskId}::uuid
  AND ${requeuedTaskSql(p.attemptId ?? null, sql`${p.deliveryId}::uuid`)}
  AND ${requeueingAttemptIsCurrentSql(p.workerId)}
  AND ${notKernelMergedTaskSql(tkCols)}
RETURNING tk.id`;
}

// ── AC-1 slice 8: an exhausted CI repair fails the owner task in its own statement ──────

/** Whether a decision escalates the delivery because its CI repairs are spent (`escalate_exhaustion`, family `ci`). */
export function escalatesCi(decision: { effects?: ApplyDecision['effects'] }): boolean {
  return (decision.effects ?? []).some((e) => e.kind === 'escalate_exhaustion' && (e.payload as { family?: unknown } | null)?.family === 'ci');
}

/**
 * The `t_escalate` CTE (workflow-kernel-library.md §9, AC-1): when the CI repairs of a delivery are
 * spent, the transition that escalates it to a person fails the owner task in its own statement,
 * reading the delivery CTE `d`, so a version miss writes nothing. This is the move
 * `escalateCiRedHead` made from the Escalate effect; the effect still writes the summary, the
 * mission note and the PR comment, and writes no status for a delivery-owned task. A cancelled or
 * already failed task keeps what it has, and a kernel-merged completion is never failed. An owner
 * end that escalates in the same transition is projected by `t_attempt` instead (one write per row).
 */
export function escalationTaskProjectionCtes(decision: Pick<ApplyDecision, 'command' | 'fromState' | 'effects'>, d = 'd'): SQL[] {
  if (!escalatesCi(decision)) return [];
  if (decision.command === 'AttemptEnded' && decision.fromState === 'WORKING') return [];
  const a = sql.raw(d);
  return [sql`t_escalate AS (
  UPDATE tasks tk SET status = 'failed', updated_at = now()
  FROM ${a} JOIN workflow_deliveries od ON od.id = ${a}.id
  WHERE tk.id = od.owner_task_id
    AND tk.status NOT IN ('failed', 'cancelled')
    AND ${notKernelMergedTaskSql(tkCols)}
  RETURNING tk.id
)`];
}

// ── AC-1 slice 8: a loop's exit settles the owner task it held ──────────────────────────

/**
 * A loop task's exit condition held (its PR's checks went green): the owner task the loop parked
 * in the queue (`pending`, its attempt ended and recorded) completes. Outside a transition, because
 * no delivery state moves: the kernel already has the held attempt's end, which the loop exit
 * re-sends (AttemptEnded, a duplicate when recorded). Moves only the delivery's owner task, only
 * while it is still `pending` with the loop satisfied (the exit's own compare-and-set wrote that),
 * only with no live attempt on it (a claim of the next iteration keeps its task), never over a
 * kernel-merged completion. Returns the task id moved, or null.
 */
export function projectLoopExitSql(p: { deliveryId: string; taskId: string }): SQL {
  return sql`-- workflow:project_loop_exit
UPDATE tasks tk SET status = 'completed', updated_at = now()
WHERE tk.id = ${p.taskId}::uuid
  AND tk.status = 'pending' AND tk.loop_state = 'satisfied'
  AND EXISTS (SELECT 1 FROM workflow_deliveries od WHERE od.id = ${p.deliveryId}::uuid AND od.owner_task_id = tk.id)
  AND NOT EXISTS (SELECT 1 FROM workers lw WHERE lw.task_id = tk.id AND ${isAttemptRowSql('lw')}
    AND lw.status NOT IN (${sql.join(TERMINAL_WORKER_STATUSES.map((s) => sql`${s}::text`), sql`, `)}))
  AND ${notKernelMergedTaskSql(tkCols)}
RETURNING tk.id`;
}
