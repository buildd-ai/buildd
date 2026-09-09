/**
 * The SQL half of token ranking. Split from ./memory-query-tokens.ts for the
 * same reasons as memory-file-scope-sql.ts: the pure tokeniser stays free of
 * drizzle so anything can import it, and this fragment can be rendered with the
 * real dialect in a test.
 *
 * That last part is not ceremony. The file-scope fragment shipped with invalid
 * SQL — an array interpolated directly became `unnest(($1, $2)::text[])`, a row
 * constructor cast to an array — and only PgDialect rendering caught it. A
 * mocked query builder cannot: it returns its seeded rows regardless of the
 * expression handed to it, and a mock that ignores `orderBy` never evaluates
 * this at all.
 */
import { sql, type SQL } from 'drizzle-orm';
import { memories } from './db/schema';

/**
 * One point per token found in a memory's title or content.
 *
 * Used as the leading `orderBy` term so the best match comes first. Without it,
 * a row matching one token outranks a row matching five purely because it was
 * touched more recently — which would make the tokenisation widen recall
 * without improving what the caller receives inside its `limit`.
 *
 * Built from the same token list as the WHERE clause, so the ordering can never
 * disagree with the filter about what counts as a match. Returns null when
 * there are no tokens, so the caller falls back to pure recency rather than
 * ordering by a constant.
 */
export function tokenMatchScoreSql(tokens: readonly string[]): SQL | null {
  if (tokens.length === 0) return null;
  const terms = tokens.map(t => {
    const pattern = `%${t}%`;
    return sql`(case when ${memories.title} ilike ${pattern} or ${memories.content} ilike ${pattern} then 1 else 0 end)`;
  });
  return sql`(${sql.join(terms, sql` + `)})`;
}
