import { and, inArray, not, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';

/**
 * "Does any other task still depend on this one?"
 *
 * Extracted from the completion handler so it can be rendered and asserted on.
 * Inline in the route it was unreachable by any test: the route's test file
 * swaps `drizzle-orm` for plain object builders, so the fragment was never
 * rendered, and the gate's own fail-open `try/catch` turns a malformed
 * predicate into the same answer as "no dependents".
 *
 * Cancelled dependents do not count — nothing is waiting on this task for work
 * that has itself been called off.
 */
export function unfinishedDependentPredicate(taskId: string): SQL | undefined {
  return and(
    // `${tasks.dependsOn}`, not the literal text `dependsOn`: a raw fragment
    // emits exactly what it is handed, and Postgres folds an unquoted
    // identifier to lower case, so the property name arrives as `dependson`
    // and the column `depends_on` is never read.
    sql`${tasks.dependsOn} @> ${JSON.stringify([taskId])}::jsonb`,
    not(inArray(tasks.status, ['cancelled'])),
  );
}

/**
 * Whether anything downstream is still waiting on this task.
 *
 * A named function rather than an inline `db.query.tasks.findFirst` in the
 * completion handler, so a test can answer this one question directly instead
 * of going through the route's shared `tasks.findFirst` mock — which answers
 * every task lookup in that handler with the same row, and so reports "yes,
 * there is a dependent" for every completion in the suite.
 */
export async function hasUnfinishedDependent(taskId: string | null | undefined): Promise<boolean> {
  // No task, nothing to depend on it. Guarded here and not in the predicate:
  // a `where` of `undefined` matches the FIRST ROW IN THE TABLE, so an absent
  // task id would make the gate refuse every completion instead of none.
  if (!taskId) return false;

  const dependent = await db.query.tasks.findFirst({
    where: unfinishedDependentPredicate(taskId),
    columns: { id: true },
  });
  return !!dependent;
}
