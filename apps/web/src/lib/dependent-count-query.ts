import { sql, inArray, type SQL } from 'drizzle-orm';
import { tasks } from '@buildd/core/db/schema';

/**
 * Counts how many OTHER tasks declare each of `claimedTaskIds` in their
 * `dependsOn` array, for the handoff announcement attached to a claim.
 *
 * Extracted from the claim route so the generated SQL can be rendered and
 * asserted in a test. It could not be before, and the bug below shipped:
 *
 *   WHERE dep_id = ANY(${claimedTaskIds})
 *
 * Interpolating a JS array into a template `sql` fragment expands it to a
 * PARAMETER LIST, not a Postgres array — so that rendered as
 * `ANY(($1, $2, $3))`, which is a row constructor. `ANY` requires an array on
 * its right-hand side, so Postgres rejected the statement every single time it
 * ran. Because this query runs AFTER the claim has been committed, each
 * otherwise-successful claim became a 500 the runner threw on, leaving the
 * worker rows it had just created to be reaped by the stale sweep — work
 * committed, then silently discarded.
 *
 * `inArray` renders `dep_id in ($1, $2, $3)`, which is valid. The caller
 * guarantees a non-empty list; `inArray` on an empty array is a degenerate
 * predicate, not an error, but the guard keeps the intent explicit.
 */
export function dependentCountQuery(claimedTaskIds: string[]): SQL {
  return sql`
      SELECT dep_id AS "taskId", count(*)::integer AS "dependentCount"
      FROM ${tasks}, jsonb_array_elements_text(${tasks.dependsOn}::jsonb) AS dep_id
      WHERE ${inArray(sql`dep_id`, claimedTaskIds)}
        AND ${tasks.status} != 'cancelled'
      GROUP BY dep_id
    `;
}
