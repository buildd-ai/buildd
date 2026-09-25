/**
 * UUID shape check for route params that are compared against a Postgres
 * `uuid` column.
 *
 * Postgres rejects a non-UUID compared to a uuid column with
 * `invalid input syntax for type uuid` (22P02). Left unchecked that throw
 * escapes the handler as a 500, which callers read as a transient server
 * fault and retry — when the id simply cannot name a row. Check the shape
 * first and answer 404 (or 400) instead.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
