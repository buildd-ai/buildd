import { sql, type SQL } from 'drizzle-orm';
import { tasks, workers } from '@buildd/core/db/schema';
import {
  DEP_SATISFYING_STATUSES,
  DEP_UNBLOCKING_PR_LIFECYCLE,
} from '@/lib/dep-gate-contract';

/**
 * Re-exported for callers already importing the contract from the gate module.
 * The definition lives in lib/dep-gate-contract.ts so the display gate
 * (`isGateSatisfied` in lib/task-presentation.ts) reads the same constant —
 * `dependenciesSatisfied()` below builds its SQL `IN (...)` list from it, so
 * neither the SQL nor the UI can drift from the contract.
 */
export { DEP_SATISFYING_STATUSES };

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
        -- Exception: a closed/abandoned PR (pr_lifecycle_status = 'closed') should
        -- unblock dependents — the work was abandoned, not merged. Without this
        -- guard a dependent task blocks forever when the upstream PR is closed.
        t2.status = 'completed'
        AND EXISTS (
          SELECT 1 FROM ${workers} w
          WHERE w.task_id = t2.id
          AND w.pr_url IS NOT NULL
          AND w.merged_at IS NULL
          AND COALESCE(w.pr_lifecycle_status, '') != ${DEP_UNBLOCKING_PR_LIFECYCLE}
        )
      )
    )
  )`;
}
