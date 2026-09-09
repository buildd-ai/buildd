// GET /api/cron/task-archive
//
// Weekly hygiene sweep: auto-archive stale terminal tasks so failed rows don't
// accumulate in the DB forever. Buildd has no `archived` status, so the de-facto
// archive is `status = 'cancelled'`.
//
// A task is archived when ALL of the following hold:
//   1. status = 'failed'                     (only failed — NOT completed; those are history/records)
//   2. updated_at < now() - interval '30 days'
//   3. it is NOT listed in the depends_on of any non-terminal task
//      (pending / assigned / in_progress) — archiving it must not silently
//      unblock or orphan work that is still live.
//
// Idempotent: cancelled rows no longer match `status = 'failed'`, so re-running
// is a no-op. Completed tasks are never touched.
//
// Also prunes worker_action_events past ACTION_EVENTS_RETENTION_DAYS and
// watcher_events past WATCHER_EVENTS_RETENTION_DAYS — see those constants' doc
// comments for why these tables (not workers.mcp_calls-style capped arrays) need
// their own age-based retention job.
//
// Auth: Bearer token matching CRON_SECRET env var.
// Recommended schedule: weekly.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { watcherEvents, workerActionEvents } from '@buildd/core/db/schema';
import { lt, sql } from 'drizzle-orm';
import { withCronRun, type CronReport } from '@/lib/cron-run';

export const maxDuration = 60;

const STALE_AFTER = '30 days';

/**
 * Raw worker_action_events retention. The drill-down this feeds only ever
 * reads 7d/30d windows (health-analytics-spec §4.3 item 5), so 45 days gives
 * a full 30d window plus buffer for a slow/retried weekly sweep — there is no
 * product reason to keep this table's rows longer than that.
 */
const ACTION_EVENTS_RETENTION_DAYS = 45;

/**
 * `watcher_events` retention. The table is an insert-only uniqueness ledger: the
 * health watcher inserts one row per firing and the UNIQUE index on
 * (project_id, kind, dedupe_key) is what suppresses a duplicate task — the
 * insert failing IS the read, so the rows are load-bearing, not telemetry, and
 * nothing else ever selects them. Left alone the table grows without bound.
 *
 * 90 days, and deliberately generous, because pruning a row whose dedupe key is
 * still CURRENT re-arms the watcher and re-files a task that already exists. A
 * key stays current for as long as its subject does: `pr-<n>-<headSha>` while a
 * release PR sits unpushed at that SHA, and `stale-<deployId>` for as long as
 * that deploy remains the newest production deploy — neither has an upper bound
 * this job can know. At 90 days the cost of being wrong is one duplicate task on
 * a subject that has been untouched for a quarter (arguably a re-alert worth
 * having), while the cost of being right is a table that stops growing forever.
 * A watcher firing is a rare event, so nothing here is volume-driven.
 */
const WATCHER_EVENTS_RETENTION_DAYS = 90;

export async function GET(req: NextRequest) {
  return withCronRun('task-archive', req, report => runCronJob(req, report));
}

async function runCronJob(req: NextRequest, report: CronReport): Promise<NextResponse> {

  // Archive stale failed tasks that nothing live still depends on.
  // The `?` jsonb operator tests whether the task's id exists as an element of a
  // dependent's depends_on array.
  const result = await db.execute(sql`
    UPDATE tasks
    SET status = 'cancelled', updated_at = now()
    WHERE status = 'failed'
      AND updated_at < now() - interval '${sql.raw(STALE_AFTER)}'
      AND NOT EXISTS (
        SELECT 1 FROM tasks dependent
        WHERE dependent.status IN ('pending', 'assigned', 'in_progress')
          AND dependent.depends_on::jsonb ? tasks.id::text
      )
    RETURNING id
  `);

  const rows = (result as any)?.rows ?? result ?? [];
  const archived = Array.isArray(rows) ? rows.length : 0;

  console.log(`[TaskArchive] Archived ${archived} stale failed task(s) (>${STALE_AFTER})`);

  let prunedActionEvents = 0;
  try {
    const cutoff = new Date(Date.now() - ACTION_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const pruned = await db
      .delete(workerActionEvents)
      .where(lt(workerActionEvents.ts, cutoff))
      .returning({ id: workerActionEvents.id });
    prunedActionEvents = pruned.length;
    console.log(`[TaskArchive] Pruned ${prunedActionEvents} worker_action_events row(s) (>${ACTION_EVENTS_RETENTION_DAYS}d)`);
  } catch (pruneErr) {
    // Non-fatal: a failed prune leaves rows for next week's run, it doesn't lose data.
    console.warn('[TaskArchive] worker_action_events prune failed:', pruneErr instanceof Error ? pruneErr.message : pruneErr);
  }

  let prunedWatcherEvents = 0;
  try {
    const cutoff = new Date(Date.now() - WATCHER_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const pruned = await db
      .delete(watcherEvents)
      .where(lt(watcherEvents.firedAt, cutoff))
      .returning({ id: watcherEvents.id });
    prunedWatcherEvents = pruned.length;
    console.log(`[TaskArchive] Pruned ${prunedWatcherEvents} watcher_events row(s) (>${WATCHER_EVENTS_RETENTION_DAYS}d)`);
  } catch (pruneErr) {
    // Non-fatal, same as above: a failed prune leaves rows for next week's run.
    console.warn('[TaskArchive] watcher_events prune failed:', pruneErr instanceof Error ? pruneErr.message : pruneErr);
  }

  const summary = { ok: true, archived, prunedActionEvents, prunedWatcherEvents };
  report({
    changed: archived + prunedActionEvents + prunedWatcherEvents,
    errors: 0,
    result: summary,
  });
  return NextResponse.json(summary);
}
