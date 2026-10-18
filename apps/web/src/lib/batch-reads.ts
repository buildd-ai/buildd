/**
 * The reads that are set, in one round trip (`db.batch`): a page builds its
 * independent queries, some conditional, and pays one neon-http request for
 * all of them. Resolves to a lookup: a read's rows, or undefined for one that
 * was not set (null) — so a caller keeps its own fallback per read.
 */
import { db } from '@buildd/core/db';

export async function batchReads(reads: ReadonlyArray<unknown>): Promise<(read: unknown) => unknown> {
  const set = reads.filter(r => r != null);
  const rows = set.length === 0 ? [] : ((await db.batch(set as unknown as Parameters<typeof db.batch>[0])) as unknown as unknown[]);
  return (read) => (read == null ? undefined : rows[set.indexOf(read)]);
}
