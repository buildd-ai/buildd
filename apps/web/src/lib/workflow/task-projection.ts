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
import { prRowOfDeliverySql } from './pr-fact-scope';

import type { MergeTaskTransition } from '@/lib/pr-merged-work';

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
