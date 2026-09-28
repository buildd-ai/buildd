/**
 * Bounded-concurrency fan-out for claim-time DB/network batches.
 *
 * Neon's per-query latency rises steeply past roughly 6 concurrent queries, so
 * an unbounded `Promise.all` over a claim's candidate tasks or claimed workers
 * just moves the wait from "sequential on our side" to "queued inside Neon" —
 * it doesn't reduce total latency once a queue is deep enough to over-fetch a
 * double-digit candidate pool. Capping the fan-out keeps one claim from
 * saturating the connection under concurrent claims.
 */

/** Cap on in-flight DB/network calls per claim-time batch (predictions, knowledge lookups). */
export const CLAIM_FANOUT_CONCURRENCY = 4;

/**
 * Runs `fn` over `items` with at most `limit` in flight at once. Results are
 * returned in input order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
