/**
 * A CI-fix attempt's worker, as the task page reads it: only the parts of its
 * two JSON logs the page draws (spec 3ef37387 R-5).
 *
 * - milestones: the whole log only when the worker has error traces, whose
 *   evidence shows the lines around each trace (error-evidence.ts). Otherwise
 *   just its `action` entries, which is all the PR lineage reads
 *   (attempt-actions.ts `nonDiffActions`).
 * - resultMeta: the keys the Attempts rows show (model usage, stop reason,
 *   durations), not the rest of the session's result.
 */
import { sql } from 'drizzle-orm';
import { workerErrorTraces, workers } from '@buildd/core/db/schema';
import { sqlExtras } from '@buildd/core/db/relational-sql';

/** The resultMeta keys the task page reads off a worker. */
export const ATTEMPT_RESULT_META_KEYS = ['modelUsage', 'terminalReason', 'stopReason', 'durationMs', 'durationApiMs'] as const;

export const ATTEMPT_MILESTONES_SQL = sql`case
  when exists (select 1 from ${workerErrorTraces} where ${workerErrorTraces.workerId} = ${workers.id}) then ${workers.milestones}
  else coalesce((
    select jsonb_agg(x.e order by x.o)
    from jsonb_array_elements(case when jsonb_typeof(${workers.milestones}) = 'array' then ${workers.milestones} else '[]'::jsonb end) with ordinality as x(e, o)
    where jsonb_typeof(x.e) = 'object' and x.e->>'type' = 'action'
  ), '[]'::jsonb)
end`;

export const ATTEMPT_RESULT_META_SQL = sql`case when jsonb_typeof(${workers.resultMeta}) = 'object'
  then jsonb_strip_nulls(jsonb_build_object(${sql.join(ATTEMPT_RESULT_META_KEYS.map(k => sql`${k}::text, ${workers.resultMeta}->${k}::text`), sql`, `)}))
end`;

/** The attempt worker's columns to leave out; {@link ATTEMPT_WORKER_EXTRAS} reads them instead. */
export const ATTEMPT_WORKER_PROJECTED_COLUMNS = { milestones: false, resultMeta: false } as const;

/** Typed as the columns they stand in for, so the page's rows keep one worker shape. */
export const ATTEMPT_WORKER_EXTRAS = sqlExtras({
  milestones: sql<typeof workers.$inferSelect.milestones>`${ATTEMPT_MILESTONES_SQL}`,
  resultMeta: sql<typeof workers.$inferSelect.resultMeta>`${ATTEMPT_RESULT_META_SQL}`,
});
