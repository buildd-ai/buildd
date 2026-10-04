/**
 * Dependency wakes for the dispatch outbox (dispatch-outbox.ts).
 *
 * A dependent task is created `pending` and stays `pending` when its last
 * dependency resolves, so the outbox trigger never sees the moment it becomes
 * runnable. The resolving write (a task completing, a PR merging) happens in
 * many places; this module is the statement each of them follows with, which
 * selects the dependents that are ready *now* and writes their intents in the
 * same statement — no read-then-write gap for a concurrent resolution to fall
 * into.
 *
 * Readiness mirrors checkDependsOnResolved (apps/web/src/lib/task-dependencies.ts):
 * every dependency exists, is `completed`, has a null or `satisfied` loop
 * state, and its most recent PR-bearing worker (if any) is merged. The claim
 * route still decides; a wake that turns out early is deferred there, which is
 * harmless. What this must never do is miss a ready dependent — that is what
 * findPendingTasksWithResolvedDepsAndNoWake repairs.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from './db';
import { outboxInsertSelectSql } from './dispatch-outbox';

const UUID_TEXT = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;

/**
 * Readiness is the claim route's dependency gate itself, passed in by the
 * caller (apps/web/src/app/api/workers/claim/deps-gate.ts `depsGate()`), not a
 * copy of it. The wake must fire whenever the claim would let the task through
 * — a cancelled dependency, a closed-unmerged PR, a force-started task — or a
 * claimable dependent waits for a runner poll. `gate` is a predicate over the
 * unaliased outer `tasks` row; the statements below select FROM tasks
 * unaliased so it binds there.
 */
export type DependencyGate = SQL;

/**
 * The gate casts each dependency id to uuid, so one malformed id fails the
 * whole statement — and in a scan, for every task. CASE (unlike AND) fixes the
 * evaluation order: the gate only runs for rows whose ids all parse, and a
 * row with a bad id stays blocked, never woken.
 */
const guardedGate = (gate: DependencyGate): SQL => sql`CASE WHEN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(COALESCE(tasks.depends_on, '[]'::jsonb)) d(dep_id)
    WHERE d.dep_id !~ ${sql.raw(UUID_TEXT)}
  ) THEN ${gate} ELSE false END`;

/**
 * Wake every pending dependent of `parentTaskId` whose dependencies are now
 * all resolved, as `dependency.satisfied`. Returns the woken task ids. Run it
 * after the parent's resolving write has committed; it coalesces into any
 * undelivered wake the task already has.
 */
export function enqueueReadyDependentsSql(parentTaskId: string, gate: DependencyGate): SQL {
  return sql`-- dispatch_dependents:enqueue_ready
WITH ready AS (
  SELECT tasks.id AS waiting_task_id
  FROM tasks
  WHERE tasks.status = 'pending'
    AND tasks.depends_on @> jsonb_build_array(${parentTaskId}::text)
    AND ${guardedGate(gate)}
),
${outboxInsertSelectSql('ready', 'dependency.satisfied')}
SELECT task_id FROM wake`;
}

type RawRow = Record<string, unknown>;
const rowsOf = (r: unknown): RawRow[] => ((r as { rows?: RawRow[] })?.rows ?? []);

export async function enqueueReadyDependents(parentTaskId: string, gate: DependencyGate): Promise<string[]> {
  const result = await db.execute(enqueueReadyDependentsSql(parentTaskId, gate));
  return rowsOf(result).map(r => String(r.task_id));
}

/**
 * Reconciliation backstop: pending tasks whose dependencies are all resolved
 * but which have had no wake since they resolved — the enqueue after the
 * resolving write never ran (crashed function, a resolving path that forgot
 * it). The caller wakes them as `dependency.satisfied`.
 *
 * "Resolved at" is the latest of each dependency's `updated_at` and PR merge,
 * so a wake that went out while a PR was still open (and was deferred by the
 * claim) does not count. An undelivered wake does count: the drain owns it.
 * Bounded by `lookbackHours` on that resolution time and by `limit`, so a
 * long-stuck task is reported a bounded number of times, not forever: one
 * wake per resolution.
 */
export async function findPendingTasksWithResolvedDepsAndNoWake(
  gate: DependencyGate,
  opts: { limit?: number; lookbackHours?: number } = {},
): Promise<string[]> {
  const limit = opts.limit ?? 100;
  const lookbackHours = opts.lookbackHours ?? 24;
  const result = await db.execute(sql`-- dispatch_dependents:find_missed
WITH cand AS MATERIALIZED (
  SELECT c.id, c.depends_on FROM tasks c
  WHERE c.status = 'pending'
    AND jsonb_typeof(c.depends_on) = 'array'
    AND c.depends_on <> '[]'::jsonb
    AND (c.start_at IS NULL OR c.start_at <= now())
),
ready AS MATERIALIZED (
  SELECT tasks.id FROM tasks WHERE tasks.id IN (SELECT id FROM cand) AND ${guardedGate(gate)}
),
resolved AS (
  SELECT r.id, max(GREATEST(p.updated_at, COALESCE(m.merged_at, p.updated_at))) AS resolved_at
  FROM ready r
  JOIN cand ON cand.id = r.id
  CROSS JOIN LATERAL jsonb_array_elements_text(cand.depends_on) d(dep_id)
  JOIN tasks p ON p.id = CASE WHEN d.dep_id ~ ${sql.raw(UUID_TEXT)} THEN d.dep_id::uuid END
  LEFT JOIN LATERAL (SELECT max(w.merged_at) AS merged_at FROM workers w WHERE w.task_id = p.id) m ON true
  GROUP BY r.id
)
SELECT r.id FROM resolved r
WHERE r.resolved_at > now() - make_interval(hours => ${Math.max(1, Math.floor(lookbackHours))}::int)
  AND NOT EXISTS (
    SELECT 1 FROM task_dispatch_outbox o
    WHERE o.task_id = r.id
      AND o.intent = 'work_execution'
      AND (o.status IN ('pending', 'delivering') OR o.updated_at >= r.resolved_at)
  )
ORDER BY r.resolved_at
LIMIT ${Math.max(1, Math.floor(limit))}::int`);
  return rowsOf(result).map(r => String(r.id));
}
