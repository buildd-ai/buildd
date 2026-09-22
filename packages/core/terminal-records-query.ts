/**
 * The only file that reads `worker_terminal_records` for a metric — the
 * house convention (see `db952fad`) is a pure writer + a dedicated `-query.ts`
 * as the sole `db`-importing reader, so `DerivedMetric<T>` absence never
 * silently renders as 0.
 *
 * `getOrphanRate` answers the question this whole ledger exists to make
 * answerable: of the sessions that started in a window, how many ended with
 * no terminal record at all? Before this table existed that number was
 * unmeasurable — a gate refusal or a crashed process left no row anywhere.
 */
import { db } from './db/client';
import { workers, workerTerminalRecords } from './db/schema';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { derivedValue, derivedUnavailable, type DerivedMetric } from './derived-metric';

export interface OrphanRateResult {
  /** Sessions whose `startedAt` falls in the window — the denominator. */
  startedCount: number;
  /** Of those, how many have at least one terminal record. */
  recordedCount: number;
  orphanCount: number;
  /** 0..1 */
  orphanRate: number;
}

export async function getOrphanRate(since: Date, until: Date = new Date()): Promise<DerivedMetric<OrphanRateResult>> {
  const [row] = await db
    .select({
      startedCount: sql<number>`count(distinct ${workers.id})`,
      recordedCount: sql<number>`count(distinct ${workerTerminalRecords.workerId})`,
    })
    .from(workers)
    .leftJoin(workerTerminalRecords, eq(workerTerminalRecords.workerId, workers.id))
    .where(and(gte(workers.startedAt, since), lt(workers.startedAt, until)));

  const startedCount = Number(row?.startedCount ?? 0);
  if (startedCount === 0) return derivedUnavailable('no_scope');

  const recordedCount = Number(row?.recordedCount ?? 0);
  const orphanCount = startedCount - recordedCount;
  return derivedValue({
    startedCount,
    recordedCount,
    orphanCount,
    orphanRate: orphanCount / startedCount,
  });
}
