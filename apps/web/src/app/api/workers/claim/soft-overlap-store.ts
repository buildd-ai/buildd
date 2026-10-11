/**
 * The one read behind the claim-time soft-overlap gate (./soft-overlap-gate.ts):
 * the named holder tasks' status, current manifest, title and newest worker
 * status. Called only when some candidate carries soft overlaps, so a claim
 * with none costs nothing.
 */
import { desc, inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import type { SoftHolderRow } from './soft-overlap-gate';

export async function loadSoftOverlapHolders(ids: string[]): Promise<Map<string, SoftHolderRow>> {
  const out = new Map<string, SoftHolderRow>();
  if (ids.length === 0) return out;
  const [taskRows, workerRows] = await Promise.all([
    db.select({ id: tasks.id, status: tasks.status, pathManifest: tasks.pathManifest, title: tasks.title })
      .from(tasks)
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
  for (const t of taskRows as Array<{ id: string; status: string; pathManifest: string[] | null; title: string | null }>) {
    out.set(t.id, { id: t.id, status: t.status, pathManifest: t.pathManifest, title: t.title, workerStatus: newest.get(t.id) ?? null });
  }
  return out;
}
