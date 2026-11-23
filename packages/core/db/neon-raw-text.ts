/**
 * Keep raw neon-http rows in the shape drizzle-orm 1.0.0-rc.4 gave them.
 *
 * rc.4's neon-http driver called `types.setTypeParser` on `@neondatabase/serverless`
 * globally, so `timestamp`, `timestamptz`, `date`, `interval`, their arrays and
 * `numeric[]` reached the app as the text Postgres sent, raw `db.execute(sql…)`
 * rows included. rc.6 removed that global: codec-decoded queries (`select`,
 * `query.*`, `insert … returning`) now ask for text per query and decode it
 * themselves, but raw queries carry no `types` and get neon's defaults, which turn
 * those columns into `Date` objects. Every raw-row reader that compares, slices
 * or serialises them as strings would change behaviour.
 *
 * neon's `neon(url, opts)` takes no client-level `types` (only per-query options
 * do), so this wraps the client's `.query` and adds drizzle's own
 * `neonHttpRawTextTypes` to any query whose options name no `types`. Queries
 * drizzle already gave `types` are left alone. The OID set is drizzle's
 * `pgRawTextOids`, identical to rc.4's global list. Scoped to the clients we
 * wrap, instead of process-wide as rc.4 was.
 *
 * Like ./query-wrapper, this returns the lazy NeonQueryPromise untouched, so
 * `db.batch` still composes it into one transaction.
 */
import { neonHttpRawTextTypes } from 'drizzle-orm/neon-http';

type TypeParser = (text: string) => unknown;

export const NEON_RAW_TEXT_TYPES = (neonHttpRawTextTypes as {
  types: { getTypeParser: (oid: number, format?: unknown) => TypeParser };
}).types;

export function withRawTextTypes<T extends { query: (...args: any[]) => any }>(client: T): T {
  const originalQuery = client.query.bind(client);
  client.query = ((queryText: unknown, params?: unknown, options?: Record<string, unknown>) => {
    const withTypes = options?.types === undefined ? { ...options, types: NEON_RAW_TEXT_TYPES } : options;
    return originalQuery(queryText, params, withTypes);
  }) as T['query'];
  return client;
}
