/**
 * Repair passes for the dispatch outbox, run by the dispatch-drain floor tick
 * (app/api/cron/dispatch-drain). Repair only: the normal path is the trigger
 * plus the kick, and these exist for intent that predates that path or was
 * lost to it. docs/specs/task-dispatch-authority.md is the contract.
 */
import { db } from '@buildd/core/db';
import { sql, type SQL } from 'drizzle-orm';
import { dispatchOutboxHealth, listFutureDispatches } from '@buildd/core/dispatch-outbox';
import { findPendingTasksWithResolvedDepsAndNoWake } from '@buildd/core/dispatch-dependents';
import { DISPATCH_DUE_QUEUE, wakeTasks } from '@/lib/dispatch-authority';
import { clearDueThrough, markDue } from '@/lib/redis';

export { dispatchOutboxHealth };

/** Bounds one floor tick; a larger backlog fills in across ticks. */
export const START_AT_BACKFILL_LIMIT = 500;

/**
 * Scheduled wakes for pending tasks with a future `start_at` and no intent
 * for that due time. The trigger writes one for every such task created or
 * deferred after it existed, so what this finds is tasks deferred before it
 * (the outbox migration ships with no backfill), plus any row lost since.
 * The hourly startAt sweep this replaces nudged them when their time passed;
 * without this they would wait for a runner's poll.
 *
 * Same due time and dedupe key as the trigger, so a trigger row written in
 * between wins the conflict and nothing doubles. Matching on the key in any
 * status, not just pending, keeps a delivered wake from being re-created.
 */
export function backfillStartAtWakesSql(limit: number = START_AT_BACKFILL_LIMIT): SQL {
  return sql`-- dispatch_outbox:backfill_start_at
WITH due AS (
  SELECT t.id, t.workspace_id, t.start_at,
    'start_at:' || floor(extract(epoch FROM t.start_at) * 1000)::bigint::text AS key
  FROM tasks t
  WHERE t.status = 'pending' AND t.start_at > now()
),
missing AS (
  SELECT d.* FROM due d
  WHERE NOT EXISTS (
    SELECT 1 FROM task_dispatch_outbox o WHERE o.task_id = d.id AND o.dedupe_key = d.key
  )
  ORDER BY d.start_at
  LIMIT ${limit}
),
ins AS (
  INSERT INTO task_dispatch_outbox (workspace_id, task_id, cause, causes, not_before, dedupe_key)
  SELECT m.workspace_id, m.id, 'start_at.reached', jsonb_build_array('start_at.reached'), m.start_at, m.key
  FROM missing m
  ON CONFLICT (task_id, dedupe_key) WHERE status = 'pending' DO NOTHING
  RETURNING 1
)
SELECT count(*) AS n FROM ins`;
}

export async function backfillStartAtWakes(limit?: number): Promise<number> {
  const result = await db.execute(backfillStartAtWakesSql(limit));
  const rows = (result as { rows?: Array<{ n?: unknown }> }).rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

/**
 * Pending tasks whose dependencies resolved with no wake since: the enqueue
 * after the resolving write never ran. Woken here so the floor's drain sends
 * them; the finder (packages/core/dispatch-dependents.ts) bounds how often.
 */
export async function repairDependencyWakes(): Promise<number> {
  const ids = await findPendingTasksWithResolvedDepsAndNoWake();
  await wakeTasks(ids, 'dependency.satisfied');
  return ids.length;
}

// ── Timer index (Redis) ────────────────────────────────────────────────────

/** Member that keeps the gated tick firing while a backlog outlasts one run. */
export const DISPATCH_BACKLOG_MEMBER = 'backlog';

/**
 * After a gated drain that emptied everything due: drop the members it
 * answered and re-publish upcoming due times. Additive (no DEL), so a kick
 * publishing concurrently is not lost. `throughMs` is when the last claim
 * began: a row that came due after it was not claimed and must stay.
 */
export async function settleDispatchTimer(throughMs: number): Promise<void> {
  await clearDueThrough(DISPATCH_DUE_QUEUE, throughMs);
  const future = await listFutureDispatches(50);
  await Promise.all(future.map(f => markDue(DISPATCH_DUE_QUEUE, f.id, f.notBefore.getTime())));
}

/** A drain that ran out of budget: due now, so the next gated tick continues it. */
export async function markDispatchBacklog(): Promise<void> {
  await markDue(DISPATCH_DUE_QUEUE, DISPATCH_BACKLOG_MEMBER, Date.now());
}
