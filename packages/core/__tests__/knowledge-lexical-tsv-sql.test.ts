import { describe, it, expect } from 'bun:test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildLexicalSearchSql } from '../knowledge-store/pg-vector-store';

// Real drizzle-orm + real PgDialect (not the fake-sql mock other pg-vector-store
// test files use) — this test's whole point is proving the generated SQL text,
// so it needs the actual renderer, not a stand-in.
const dialect = new PgDialect();

describe('buildLexicalSearchSql', () => {
  it('ranks and matches against the stored lexical_tsv column, never recomputing to_tsvector', () => {
    const query = buildLexicalSearchSql('ws-1:task', 'auth flow', sql``, sql`AND is_current = true`, 10);
    const { sql: text } = dialect.sqlToQuery(query);

    expect(text).not.toContain('to_tsvector');
    expect(text).toContain('ts_rank(lexical_tsv, websearch_to_tsquery(');
    expect(text).toContain('lexical_tsv @@ websearch_to_tsquery(');
  });

  it('applies the caller-supplied filter and currency clauses', () => {
    const query = buildLexicalSearchSql(
      'ws-1:code',
      'claim route',
      sql`AND corpus = ${'code'}`,
      sql`AND is_current = true`,
      25,
    );
    const { sql: text } = dialect.sqlToQuery(query);

    expect(text).toContain('AND corpus =');
    expect(text).toContain('AND is_current = true');
    expect(text).toContain('LIMIT');
  });
});
