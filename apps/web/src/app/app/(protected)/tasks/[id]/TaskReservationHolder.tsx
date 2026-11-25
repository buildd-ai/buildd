/**
 * Resolves the holder's account name inside the render of the row itself, so the
 * lookup streams with the row instead of adding a serial wait to the task page.
 */
import type { ReactElement } from 'react';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { liveReservation } from '@/lib/task-reservation';
import { TaskReservation } from './TaskReservation';

export async function TaskReservationHolder({ context, status }: { context: unknown; status: string }): Promise<ReactElement | null> {
  const r = liveReservation(context, status);
  if (!r) return null;
  const [row] = await db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, r.accountId)).limit(1);
  return <TaskReservation context={context} status={status} holderName={row?.name ?? null} />;
}
