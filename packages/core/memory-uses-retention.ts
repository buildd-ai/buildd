/**
 * Retention for the memory use ledger (`memory_uses`).
 *
 * Rows older than MEMORY_USES_RETENTION_DAYS are deleted in one bounded,
 * oldest-first batch per run. Run from an existing daily cron (see
 * /api/cron/memory-digest-guardrail) so it adds no database wake window; a
 * backlog larger than one batch drains over the following runs.
 *
 * 90 days covers several memory half-lives of the use signal consolidation
 * reads, and the decay test's warm-up only needs the team's first row
 * inside the most recent half-life.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from './db';
import { memoryUses } from './db/schema';

export const MEMORY_USES_RETENTION_DAYS = 90;
export const MEMORY_USES_PRUNE_BATCH = 5000;

/** DELETE the oldest `limit` rows created before `cutoff`, returning their ids. */
export function pruneMemoryUsesSql(cutoff: Date, limit: number): SQL {
  return sql`
    DELETE FROM ${memoryUses}
    WHERE ${memoryUses.id} IN (
      SELECT ${memoryUses.id} FROM ${memoryUses}
      WHERE ${memoryUses.createdAt} < ${cutoff.toISOString()}
      ORDER BY ${memoryUses.createdAt}
      LIMIT ${limit}
    )
    RETURNING ${memoryUses.id}
  `;
}

export async function pruneMemoryUses(opts: {
  now?: Date;
  retentionDays?: number;
  batchSize?: number;
} = {}): Promise<{ deleted: number; cutoff: string; batchFull: boolean }> {
  const now = opts.now ?? new Date();
  const days = opts.retentionDays ?? MEMORY_USES_RETENTION_DAYS;
  const batch = opts.batchSize ?? MEMORY_USES_PRUNE_BATCH;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const res = await db.execute(pruneMemoryUsesSql(cutoff, batch));
  const deleted = (res.rows as unknown[]).length;
  return { deleted, cutoff: cutoff.toISOString(), batchFull: deleted >= batch };
}
