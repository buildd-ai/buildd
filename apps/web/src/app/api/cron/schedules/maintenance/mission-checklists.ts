import { db } from '@buildd/core/db';
import { taskSchedules } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { repairChecklist } from '@/lib/checklist-text';

/**
 * A mission's checklist copy lives on its schedule, at taskTemplate.context.heartbeatChecklist.
 * One-time replacement per stored copy. Counts live in the private cron report.
 */
export async function repairMissionChecklists() {
  const counts = { updated: 0, customized: 0, current: 0, raced: 0 };
  const stored = sql<string | null>`${taskSchedules.taskTemplate}->'context'->>'heartbeatChecklist'`;
  const rows = await db.select({ id: taskSchedules.id, heartbeatChecklist: stored })
    .from(taskSchedules)
    .where(sql`${stored} is not null`);
  for (const row of rows) {
    if (row.heartbeatChecklist === null) continue;
    const repair = repairChecklist(row.heartbeatChecklist);
    if (repair.kind !== 'updated') {
      counts[repair.kind === 'custom' ? 'customized' : 'current']++;
      continue;
    }
    // jsonb_set touches only the checklist; the predicate skips a copy edited since the read.
    const changed = await db.update(taskSchedules)
      .set({ taskTemplate: sql`jsonb_set(${taskSchedules.taskTemplate}, '{context,heartbeatChecklist}', to_jsonb(${repair.text}::text))` })
      .where(and(eq(taskSchedules.id, row.id), sql`${stored} = ${row.heartbeatChecklist}`))
      .returning({ id: taskSchedules.id });
    if (changed.length) counts.updated++;
    else counts.raced++;
  }
  return counts;
}
