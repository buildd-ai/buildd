/**
 * A live worker's last reported progress (0..100), from the `progress` field
 * runners put on `status` milestones. One batched read for a set of workers —
 * the milestone array itself never leaves the database.
 */
import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { inArray, sql } from 'drizzle-orm';

/** The newest milestone's numeric `progress`, clamped to 0..100. Null when none reported. */
export function latestMilestoneProgress(milestones: ReadonlyArray<{ progress?: unknown }> | null | undefined): number | null {
  if (!milestones) return null;
  for (let i = milestones.length - 1; i >= 0; i--) {
    const p = milestones[i]?.progress;
    if (typeof p === 'number' && Number.isFinite(p)) return Math.max(0, Math.min(100, p));
  }
  return null;
}

/** SQL twin of `latestMilestoneProgress`, for a select list. */
export const workerProgressSql = sql<number | null>`(
  select least(100, greatest(0, (m->>'progress')::float))
  from jsonb_array_elements(coalesce(${workers.milestones}, '[]'::jsonb)) with ordinality as e(m, i)
  where jsonb_typeof(m->'progress') = 'number'
  order by i desc limit 1
)`;

export async function loadWorkerProgress(workerIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workerIds.length === 0) return out;
  const rows = await db
    .select({ id: workers.id, pct: workerProgressSql })
    .from(workers)
    .where(inArray(workers.id, [...workerIds]));
  for (const r of rows) if (r.pct != null) out.set(r.id, Number(r.pct));
  return out;
}
