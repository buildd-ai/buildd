import { sql, type SQL } from 'drizzle-orm';
import { tasks, workers } from '@buildd/core/db/schema';

/**
 * Dependency statuses that SATISFY (unblock) a dependent task in the claim gate.
 *
 *   - `completed` — the delivered path (an open/unmerged PR still blocks; see below).
 *   - `cancelled` — an intentional "this won't be delivered" signal. Cancelling a
 *     dead/abandoned dependency is a deliberate act; its dependents should proceed
 *     rather than be gated forever. (Previously a cancelled dep blocked every
 *     dependent indefinitely — a footgun.)
 *
 * Any other status — notably `failed`, `pending`, `in_progress` — remains BLOCKING.
 *
 * This constant is the single source of truth: `dependenciesSatisfied()` builds
 * its SQL `IN (...)` list from it, so the SQL cannot drift from the contract.
 */
export const DEP_SATISFYING_STATUSES = ['completed', 'cancelled'] as const;

/**
 * Dependency-completion gate for the claim route.
 *
 * Returns a SQL condition that is TRUE when every id in `tasks.depends_on`
 * resolves to a satisfied dependency:
 *
 *   satisfied = status ∈ DEP_SATISFYING_STATUSES
 *               AND NOT (status = 'completed' AND the dep has an open/unmerged PR)
 *
 * The open-PR guard only applies to `completed` deps — it prevents a downstream
 * task from starting while an upstream PR is still open (root cause of the
 * 6-overlapping-PR burst, PRs #1044-1049). `cancelled` deps carry no such guard.
 *
 * Callers should OR this with the bypass conditions (no deps, empty deps,
 * `context.bypassDepsGate = 'true'`).
 */
export function dependenciesSatisfied(): SQL {
  const satisfyingStatuses = sql.join(
    DEP_SATISFYING_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );

  return sql`NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${tasks.dependsOn}::jsonb) AS dep_id
    WHERE NOT EXISTS (
      SELECT 1 FROM ${tasks} t2
      WHERE t2.id = dep_id::uuid
      AND t2.status IN (${satisfyingStatuses})
      AND NOT (
        -- A completed dep with a still-open PR keeps blocking its dependents.
        t2.status = 'completed'
        AND EXISTS (
          SELECT 1 FROM ${workers} w
          WHERE w.task_id = t2.id
          AND w.pr_url IS NOT NULL
          AND w.merged_at IS NULL
        )
      )
    )
  )`;
}
