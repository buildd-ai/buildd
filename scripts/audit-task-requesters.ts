#!/usr/bin/env bun
/**
 * Audit who tasks are for, after migration *_task_requester_trigger. Read-only.
 *
 * Prints:
 *   1. tasks by requester_source (how the person was decided);
 *   2. the exceptions: tasks still with no person, by why and by creation_source;
 *   3. runner work over the window, with and without a task owner — the
 *      population Health's "unattributed" coverage counts.
 *
 * Run from the repo root:
 *   bun run scripts/audit-task-requesters.ts [--days=30]
 *
 * Requires DATABASE_URL. Counts only: no ids, titles or people are printed, so
 * the output is safe to paste into a task. Keep it out of the public repo all
 * the same.
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set');
  process.exit(1);
}
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const DAYS = daysArg ? Number(daysArg.slice('--days='.length)) : 30;
if (!Number.isFinite(DAYS) || DAYS <= 0) {
  console.error('ERROR: --days must be a positive number');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

async function main() {
  const bySource = await sql`
    SELECT COALESCE(requester_source, '(recorded before provenance)') AS source,
           count(*)::int AS tasks,
           count(created_by_user_id)::int AS with_person
    FROM tasks GROUP BY 1 ORDER BY 2 DESC`;
  console.log('\nTasks by requester_source');
  console.table(bySource);

  const exceptions = await sql`
    SELECT COALESCE(requester_source, '(none recorded)') AS why,
           COALESCE(creation_source, '(unset)') AS creation_source,
           count(*)::int AS tasks
    FROM tasks WHERE created_by_user_id IS NULL
    GROUP BY 1, 2 ORDER BY 3 DESC`;
  console.log('\nUnresolved: tasks with no person');
  console.table(exceptions);

  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const runnerWork = await sql`
    SELECT COALESCE(t.creation_source, '(no task)') AS creation_source,
           COALESCE(t.requester_source, '(recorded before provenance)') AS source,
           count(*)::int AS runner_workers,
           count(*) FILTER (WHERE t.created_by_user_id IS NULL)::int AS unattributed
    FROM workers w LEFT JOIN tasks t ON t.id = w.task_id
    WHERE w.started_at >= ${since}::timestamptz
      AND w.runner NOT IN ('mcp', 'system', 'external', 'openclaw') -- lib/executor.ts: runner work only
    GROUP BY 1, 2 ORDER BY 4 DESC, 3 DESC`;
  console.log(`\nRunner workers started in the last ${DAYS}d`);
  console.table(runnerWork);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
