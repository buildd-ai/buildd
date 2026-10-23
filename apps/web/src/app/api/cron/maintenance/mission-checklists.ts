import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { repairChecklist } from '@/lib/mission-checklist-repair';

/** One-time replacement per stored copy. Counts live in the private cron report. */
export async function repairMissionChecklists() {
  const counts = { updated: 0, customized: 0, current: 0, raced: 0 };
  const rows = await db.select({ id: missions.id, heartbeatChecklist: missions.heartbeatChecklist }).from(missions);
  for (const row of rows) {
    if (row.heartbeatChecklist === null) continue;
    const repair = repairChecklist(row.heartbeatChecklist);
    if (repair.kind !== 'updated') {
      counts[repair.kind === 'custom' ? 'customized' : 'current']++;
      continue;
    }
    const changed = await db.update(missions)
      .set({ heartbeatChecklist: repair.text })
      .where(and(eq(missions.id, row.id), eq(missions.heartbeatChecklist, row.heartbeatChecklist)))
      .returning({ id: missions.id });
    if (changed.length) counts.updated++;
    else counts.raced++;
  }
  return counts;
}
