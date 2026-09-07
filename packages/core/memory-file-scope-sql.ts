/**
 * The SQL half of file-scoped memory retrieval. Split from
 * ./memory-file-scope.ts so the pure predicate stays importable from the runner
 * without pulling drizzle in, and so this fragment can be rendered in a test
 * without mocking `db` — a mocked query builder returns its seeded rows
 * regardless of the condition handed to it, which makes a WHERE fragment
 * unobservable.
 *
 * `memoryFilesMatch` in the sibling module is the executable specification this
 * must agree with; a parity test asserts it.
 */
import { sql, type SQL } from 'drizzle-orm';
import { memories } from './db/schema';

/**
 * A WHERE fragment selecting memories whose `files` overlap `scopePaths`.
 *
 * One `EXISTS` over a cross join of both arrays, so the query shape is constant
 * regardless of how many paths were declared — rather than N OR'd clauses that
 * grow the statement with the manifest.
 *
 * Prefix matching uses `left(…) = … || '/'` rather than `LIKE … || '/%'` on
 * purpose. A stored path routinely contains `_` (`worker_action_events`), which
 * `LIKE` reads as a single-character wildcard, so the pattern form would match
 * paths it should not and there is no way to escape a value that comes from a
 * column. `left()` is an exact comparison with no pattern semantics, so it
 * needs no escaping in either direction.
 *
 * The path list is bound with `sql.param` rather than interpolated directly.
 * A bare `${array}` makes drizzle expand the array into one placeholder per
 * element, producing `unnest(($1, $2, $3)::text[])` — a row constructor cast to
 * an array, which is not valid SQL. `sql.param` binds the whole array as a
 * single parameter and keeps the statement shape constant.
 *
 * Returns null when there is nothing to scope by, so callers can distinguish
 * "no path scope was declared" from "a path scope matched nothing" — those are
 * different retrieval outcomes and the caller reports them differently.
 */
export function memoryFilesOverlapSql(scopePaths: readonly string[]): SQL | null {
  if (scopePaths.length === 0) return null;
  return sql`EXISTS (
    SELECT 1
    FROM unnest(${memories.files}) AS mf(path),
         unnest(${sql.param([...scopePaths])}::text[]) AS sp(path)
    WHERE mf.path = sp.path
       OR left(mf.path, length(sp.path) + 1) = sp.path || '/'
       OR left(sp.path, length(mf.path) + 1) = mf.path || '/'
  )`;
}
