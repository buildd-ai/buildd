/**
 * The red-PR sweep's floor predicate, rendered through PgDialect so its WHERE
 * scoping is asserted rather than mocked away, and the red-since derivation.
 */
import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { ciRedFloorWhere, checksFromSuites } = await import('./ci-red-sweep-deps');

describe('ciRedFloorWhere', () => {
  const q = new PgDialect().sqlToQuery(ciRedFloorWhere());

  it('only open, unmerged worker PRs whose lifecycle is ci_failed', () => {
    expect(q.sql).toContain('"workers"."pr_number" is not null');
    expect(q.sql).toContain('"workers"."merged_at" is null');
    expect(q.sql).toContain('"workers"."pr_lifecycle_status" = $');
    expect(q.params).toContain('ci_failed');
  });

  it('excludes owners a human already holds (failed — what an escalation sets — or cancelled), but keeps adopted PRs', () => {
    expect(q.sql).toContain('"workers"."task_id"');
    expect(q.sql).toContain("t.status NOT IN ('failed', 'cancelled')");
    expect(q.sql).toContain("t.context->>'adoptedPr'");
  });
});

describe('checksFromSuites', () => {
  it('only the newest suite determines verdict: old failures are superseded by new passes', () => {
    const r = checksFromSuites([
      { status: 'completed', conclusion: 'success', updated_at: '2026-10-02T11:59:00Z' },
      { status: 'completed', conclusion: 'failure', updated_at: '2026-10-02T11:00:00Z' },
      { status: 'completed', conclusion: 'timed_out', updated_at: '2026-10-02T11:30:00Z' },
    ]);
    expect(r).toEqual({ lifecycle: 'ci_green', redSinceMs: null });
  });

  it('red since the newest failed suite completed', () => {
    const r = checksFromSuites([
      { status: 'completed', conclusion: 'failure', updated_at: '2026-10-02T11:59:00Z' },
      { status: 'completed', conclusion: 'success', updated_at: '2026-10-02T11:00:00Z' },
      { status: 'completed', conclusion: 'timed_out', updated_at: '2026-10-02T11:30:00Z' },
    ]);
    expect(r).toEqual({ lifecycle: 'ci_failed', redSinceMs: Date.parse('2026-10-02T11:59:00Z') });
  });

  it('a running suite is running, with no red-since', () => {
    expect(checksFromSuites([
      { status: 'in_progress', conclusion: null, latest_check_runs_count: 2 },
      { status: 'completed', conclusion: 'failure', updated_at: '2026-10-02T11:00:00Z' },
    ])).toEqual({ lifecycle: 'ci_running', redSinceMs: null });
  });

  it('red with no timestamps → red-since unknown (the sweep then acts without waiting)', () => {
    expect(checksFromSuites([{ status: 'completed', conclusion: 'failure' }])).toEqual({ lifecycle: 'ci_failed', redSinceMs: null });
  });

  it('green and absent', () => {
    expect(checksFromSuites([{ status: 'completed', conclusion: 'success' }]).lifecycle).toBe('ci_green');
    expect(checksFromSuites(null).lifecycle).toBeNull();
  });
});
