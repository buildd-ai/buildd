/**
 * The rows a pending task's hold names (`derivePendingTaskHold`): the task an
 * overlap deferral recorded as its blocker, or an unmet dependency, with
 * enough to name it and to say whether it is a live hold. Server-only.
 *
 * Two reads by id list: the holder rows (title, status, start, newest worker
 * for the merge), and their own newest claim refusal (a holder the gate has
 * itself refused for a day is a dead hold, and is said so).
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';
import { holderFacts, type HolderSourceRow, type PendingHolderFacts } from './mission-task-hold';
import { loadClaimHolds } from './mission-claim-deferrals';

export { holderFacts, type HolderSourceRow };

/**
 * Holder facts for `ids`: `known` rows are read as given (one less query), the
 * rest are loaded. Every holder's own newest refusal is read in one query. A
 * failed read leaves the holder unnamed, never misnamed.
 */
export async function loadPendingHolderFacts(
  ids: readonly string[],
  known: ReadonlyMap<string, HolderSourceRow> = new Map(),
): Promise<Map<string, PendingHolderFacts>> {
  const out = new Map<string, PendingHolderFacts>();
  const want = [...new Set(ids)];
  if (want.length === 0) return out;
  const missing = want.filter(id => !known.has(id));
  try {
    const [rows, holds] = await Promise.all([
      missing.length > 0
        ? db.query.tasks.findMany({
            where: sqlWhere(inArray(tasks.id, missing)),
            columns: { id: true, title: true, status: true, startAt: true },
            with: { workers: { columns: { mergedAt: true }, orderBy: sqlOrderByFn((w, { desc }) => [desc(w.startedAt)]), limit: 3 } },
          })
        : Promise.resolve([] as HolderSourceRow[]),
      loadClaimHolds(want),
    ]);
    const byId = new Map<string, HolderSourceRow>(known);
    for (const r of rows as HolderSourceRow[]) byId.set(r.id, r);
    for (const id of want) {
      const row = byId.get(id);
      if (row) out.set(id, holderFacts(row, holds.get(id)?.firstDeferredAt ?? null));
    }
  } catch {
    for (const id of want) {
      const row = known.get(id);
      if (row) out.set(id, holderFacts(row));
    }
  }
  return out;
}
