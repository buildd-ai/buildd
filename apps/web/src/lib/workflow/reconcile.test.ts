import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { floorCandidatesSql, treadmillCycleCandidatesSql } from './reconcile';

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

describe('treadmillCycleCandidatesSql (S15 cycles)', () => {
  const dialect = new PgDialect();
  test('kernel deliveries the treadmill escalated, pinned to that transition, past the cooldown', () => {
    const q = dialect.sqlToQuery(treadmillCycleCandidatesSql({ limit: 20, cooldownMs: 3_600_000 }));
    expect(q.sql).toContain("d.authority = 'kernel'");
    expect(q.sql).toContain("d.state = 'ESCALATED'");
    expect(q.sql).toContain("d.state_reason = 'landing_needs_human'");
    // The escalation that produced the delivery's CURRENT version, and only a treadmill one:
    // a later merge refusal or a person's move is a newer version and never qualifies.
    expect(q.sql).toContain('t.to_version = d.version');
    expect(q.sql).toContain("t.idempotency_key LIKE '%:treadmill'");
    expect(q.sql).toContain('t.created_at <= now() - make_interval');
    expect(q.params).toEqual([3_600_000, 20]);
  });
});
