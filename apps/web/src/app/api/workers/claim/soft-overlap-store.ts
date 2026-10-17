/**
 * The one read behind the claim-time soft-overlap gate (./soft-overlap-gate.ts):
 * the named holder tasks' status, current manifest, title and newest worker
 * status. Called only when some candidate carries soft overlaps, so a claim
 * with none costs nothing.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers, missions } from '@buildd/core/db/schema';
import { holderCannotStart, type SoftHolderRow } from './soft-overlap-gate';

export async function loadSoftOverlapHolders(ids: string[]): Promise<Map<string, SoftHolderRow>> {
  const out = new Map<string, SoftHolderRow>();
  if (ids.length === 0) return out;
  const [taskRows, workerRows] = await Promise.all([
    db.select({ id: tasks.id, status: tasks.status, pathManifest: tasks.pathManifest, title: tasks.title, startAt: tasks.startAt, missionHeld: missions.isHeld })
      .from(tasks)
      .leftJoin(missions, eq(missions.id, tasks.missionId))
      .where(inArray(tasks.id, ids)),
    db.select({ taskId: workers.taskId, status: workers.status })
      .from(workers)
      .where(inArray(workers.taskId, ids))
      .orderBy(desc(workers.createdAt)),
  ]);
  const newest = new Map<string, string>();
  for (const w of workerRows as Array<{ taskId: string | null; status: string }>) {
    if (w.taskId && !newest.has(w.taskId)) newest.set(w.taskId, w.status);
  }
  for (const t of taskRows as Array<{ id: string; status: string; pathManifest: string[] | null; title: string | null; startAt: Date | null; missionHeld: boolean | null }>) {
    out.set(t.id, { id: t.id, status: t.status, pathManifest: t.pathManifest, title: t.title, startAt: t.startAt, missionHeld: t.missionHeld === true, workerStatus: newest.get(t.id) ?? null });
  }
  return out;
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
