/**
 * The narrowed reads behind every listed mission's stage (`loadMissionStages`),
 * which `buildd top` polls. Reading whole `tasks.context` blobs and every
 * worker row of every listed mission made these routes most of the database's
 * egress (knowledge-base: buildd/reports/core-page-performance-2026-10-17.md).
 *
 * - `stageContextSql`: a task's context reduced to the keys `deliverableRole`
 *   reads (`DELIVERABLE_ROLE_CONTEXT_KEYS`). An object marker becomes `{}`
 *   (the role only asks whether it is an object), a value stays itself, an
 *   absent or null key is dropped.
 * - `stageWorkersPredicate`: the newest `LATEST_WORKERS_PER_TASK` workers of a
 *   task (never-started first, as the page's `startedAt DESC` orders them),
 *   plus every worker that carries a PR. The stage reads only PR-bearing
 *   workers; the progress cells read the shown worker and the merged PRs.
 */
import { sql, or, isNotNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { tasks, workers } from '@buildd/core/db/schema';
import { DELIVERABLE_ROLE_CONTEXT_KEYS } from '@buildd/core/mission-helpers';

export const LATEST_WORKERS_PER_TASK = 3;

const contextKey = (k: string) => sql`${tasks.context} -> ${k}::text`;

const projected: SQL[] = [
  ...DELIVERABLE_ROLE_CONTEXT_KEYS.objectMarkers.map(k =>
    sql`${k}::text, case when jsonb_typeof(${contextKey(k)}) = 'object' then '{}'::jsonb end`),
  ...DELIVERABLE_ROLE_CONTEXT_KEYS.values.map(k => sql`${k}::text, ${contextKey(k)}`),
];

/** `tasks.context` reduced to what the stage reads; `{}` when none of it is set. */
export const stageContextSql = sql<Record<string, unknown> | null>`jsonb_strip_nulls(jsonb_build_object(${sql.join(projected, sql`, `)}))`;

const NEWER = 'w_newer';
/** The same table under another name, so the count reads a task's other workers. */
const newer = alias(workers, NEWER);

/** Keep a worker when it carries a PR or fewer than `n` workers of its task are newer. */
export function stageWorkersPredicate(n = LATEST_WORKERS_PER_TASK): SQL {
  return or(
    isNotNull(workers.prUrl),
    sql`(select count(*) from ${workers} ${sql.identifier(NEWER)} where ${newer.taskId} = ${workers.taskId}
      and (coalesce(${newer.startedAt}, 'infinity'::timestamptz), ${newer.id}) > (coalesce(${workers.startedAt}, 'infinity'::timestamptz), ${workers.id})) < ${n}`,
  )!;
}
