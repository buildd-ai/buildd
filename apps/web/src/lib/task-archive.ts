/**
 * The weekly archive of stale failed tasks (cron/task-archive): a task failed for longer than
 * `staleAfter` that nothing live still depends on becomes cancelled.
 *
 * S4b (docs/specs/workflow-kernel-library.md §1): a failed owner whose PR a live kernel delivery
 * still carries is skipped. Its PR is open, in review or landing, and where it ends (merged,
 * superseded, abandoned) is the kernel's transition, not a sweep's. Once the delivery is
 * terminal the task archives as before.
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { deliveryOwnedTaskSql } from '@/lib/workflow/pr-fact-scope';

/** `staleAfter` is a Postgres interval literal from the route's own constant, never input. */
export async function archiveStaleFailedTasks(staleAfter: string): Promise<number> {
  // The `?` jsonb operator tests whether the task's id exists as an element of a
  // dependent's depends_on array.
  const result = await db.execute(sql`
    UPDATE tasks
    SET status = 'cancelled', updated_at = now()
    WHERE status = 'failed'
      AND updated_at < now() - interval '${sql.raw(staleAfter)}'
      AND NOT EXISTS (
        SELECT 1 FROM tasks dependent
        WHERE dependent.status IN ('pending', 'assigned', 'in_progress')
          AND dependent.depends_on::jsonb ? tasks.id::text
      )
      AND NOT ${deliveryOwnedTaskSql(sql`tasks.id`, { live: true })}
    RETURNING id
  `);
  const rows = (result as { rows?: unknown[] })?.rows ?? result ?? [];
  return Array.isArray(rows) ? rows.length : 0;
}
