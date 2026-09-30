import { and, eq, sql, type SQL } from 'drizzle-orm';
import { tasks } from '@buildd/core/db/schema';
import { notHeldOrLocal } from '@/app/api/workers/claim/held-gate';

/**
 * Pending tasks told about a connector block and not yet reminded. Held work,
 * and work in a held or local-executor mission, is not waiting on the
 * connector, so the claim route's own gates exclude it.
 */
export function connectorBlockReminderWhere(): SQL {
  return and(
    eq(tasks.status, 'pending'),
    sql`${tasks.context}->>'connectorBlockNotifiedAt' IS NOT NULL`,
    sql`${tasks.context}->>'connectorBlockReminderSentAt' IS NULL`,
    notHeldOrLocal(),
  )!;
}
