/**
 * One round of a page's independent reads in one neon-http round trip
 * (`db.batch`): how a page meets its query budget (spec 3ef37387). Each entry
 * is an un-run Drizzle query (relational, select, joins and extras all work
 * in a batch); a null entry is a read the round does not need, which comes
 * back null and is never sent.
 */
import { db } from '@buildd/core/db';

type BatchItem = PromiseLike<unknown>;
export type RoundResults<R> = { [K in keyof R]: Awaited<R[K]> };

export async function readRound<R extends Record<string, BatchItem | null>>(reads: R): Promise<RoundResults<R>> {
  const keys = Object.keys(reads).filter(k => reads[k] != null);
  const results = keys.length > 0 ? (await db.batch(keys.map(k => reads[k]) as never)) as unknown[] : [];
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(reads)) out[k] = null;
  keys.forEach((k, i) => { out[k] = results[i]; });
  return out as RoundResults<R>;
}
