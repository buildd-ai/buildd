/**
 * Which open-PR and lease holders cannot start themselves, so hold nobody at
 * claim (./overlap-policy). One batched read per claim.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, missions } from '@buildd/core/db/schema';

/**
 * A pending holder that cannot start itself (a future `startAt`, a held
 * mission, a person's hold on the task) is not working on its files, so it
 * holds nobody off them: the open-PR and live-lease checks in ./overlap-policy
 * skip it.
 */
export function holderCannotStart(
  h: { status: string; startAt?: Date | string | null; missionHeld?: boolean | null; taskHeld?: boolean | null },
  now: Date = new Date(),
): boolean {
  if (h.status !== 'pending') return false;
  if (h.missionHeld || h.taskHeld) return true;
  return !!h.startAt && new Date(h.startAt).getTime() > now.getTime();
}

/**
 * Of the open-PR and lease holders named, the ones that cannot start
 * themselves (`holderCannotStart`): they hold nobody (./overlap-policy).
 */
export async function loadIdleHolderIds(ids: string[], now: Date = new Date()): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.select({
    id: tasks.id, status: tasks.status, startAt: tasks.startAt, missionHeld: missions.isHeld,
    taskHeld: sql<boolean>`(${tasks.context}->'heldBy') IS NOT NULL`,
  })
    .from(tasks)
    .leftJoin(missions, eq(missions.id, tasks.missionId))
    .where(inArray(tasks.id, ids));
  return new Set((rows as Array<{ id: string; status: string; startAt: Date | null; missionHeld: boolean | null; taskHeld: boolean | null }>)
    .filter(r => holderCannotStart(r, now)).map(r => r.id));
}
