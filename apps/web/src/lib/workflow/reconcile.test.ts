import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { floorCandidatesSql } from './reconcile';

describe('floorCandidatesSql', () => {
  const dialect = new PgDialect();
  test('non-terminal, PR-bound, quiet deliveries, stalest first, capped', () => {
    const q = dialect.sqlToQuery(floorCandidatesSql({ limit: 50, minQuietMs: 300_000 }));
    expect(q.sql).toContain('pr_number IS NOT NULL');
    expect(q.sql).toContain('state NOT IN');
    expect(q.sql).toContain('ORDER BY COALESCE(last_transition_at, updated_at) ASC, id');
    expect(q.sql).not.toContain('AND id IN');
    expect(q.params).toEqual([JSON.stringify(['MERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED']), 300_000, 50]);
  });
  test('`only` narrows the pass to named deliveries', () => {
    const q = dialect.sqlToQuery(floorCandidatesSql({ limit: 5, minQuietMs: 0, only: ['d1'] }));
    expect(q.sql).toContain('AND id IN');
    expect(q.params).toContain('["d1"]');
  });
});
