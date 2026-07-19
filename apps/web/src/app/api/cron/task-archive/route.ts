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
// Auth: Bearer token matching CRON_SECRET env var.
// Recommended schedule: weekly.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { sql } from 'drizzle-orm';

export const maxDuration = 60;

const STALE_AFTER = '30 days';

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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

  return NextResponse.json({ ok: true, archived });
}
