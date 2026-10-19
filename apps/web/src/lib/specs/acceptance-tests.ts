import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';

/** The mission's unfinished acceptance-tests task, if any: a task filed later in the mission waits for it too. */
export async function openAcceptanceTestsTaskId(missionId: string): Promise<string | null> {
  const rows = await db.query.tasks.findMany({
    where: sqlWhere(and(eq(tasks.missionId, missionId), sql`${tasks.context}->'acceptanceTests' IS NOT NULL`)),
    columns: { id: true, status: true },
  });
  return rows.find((r) => r.status !== 'completed' && !(TERMINAL_TASK_STATUSES as readonly string[]).includes(r.status))?.id ?? null;
}
