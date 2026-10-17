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
import { INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';
import { TERMINAL_PR_LIFECYCLE } from '@/lib/dep-gate-contract';
import { notKernelMergedTaskSql, prRowOfDeliverySql } from './pr-fact-scope';

import type { MergeTaskTransition } from '@/lib/pr-merged-work';
import type { ApplyDecision } from './commands';

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
 * The `t_attempt` CTE (workflow-kernel-library.md §9, AC-1): T4 for an owner sets the owner task
 * in the transition's own statement. It reads the delivery CTE `d` (empty on a CAS miss), so a
 * version miss writes nothing. Only an owner end has a task to project: the end of the attempt a
 * `WORKING` delivery is bound to (a repair's end is FIXING/REPAIRING and its task is not the
 * owner). Empty when the decision projects nothing.
 */
export function attemptEndTaskProjectionCtes(decision: Pick<ApplyDecision, 'command' | 'fromState' | 'evidence'>, d = 'd'): SQL[] {
  if (decision.command !== 'AttemptEnded' || decision.fromState !== 'WORKING') return [];
  const status = ownerEndTaskStatus(decision.evidence as { outcome?: unknown; requeue?: unknown });
  if (!status) return [];
  const a = sql.raw(d);
  return [sql`t_attempt AS (
  UPDATE tasks tk SET status = ${status}::text, updated_at = now()
  FROM ${a} JOIN workflow_deliveries od ON od.id = ${a}.id
  WHERE tk.id = od.owner_task_id
    AND tk.status IN (${open})
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
 * never over a kernel-merged completion. Returns the status written, or null when nothing moved.
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
  AND ${notKernelMergedTaskSql(tkCols)}
RETURNING tk.status`;
}
