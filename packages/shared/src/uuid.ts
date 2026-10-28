/**
 * UUID shape check — the one definition for the monorepo.
 *
 * Shape only (8-4-4-4-12 hex, either case): no version or variant check, so
 * every id Postgres' `uuid` type accepts in canonical form passes. Anything
 * else compared to a `uuid` column throws 22P02 (`invalid input syntax for
 * type uuid`), which escapes a handler as a 500 — check first, answer 404/400.
 * Non-strings (null, undefined, numbers) are not UUIDs.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
