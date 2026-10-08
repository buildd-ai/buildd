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
  it('same workflow: newest suite determines verdict', () => {
    const r = checksFromSuites([
      { status: 'completed', conclusion: 'success', updated_at: '2026-10-02T11:59:00Z', app: { id: 1 }, workflow_run: { id: 1 } },
      { status: 'completed', conclusion: 'failure', updated_at: '2026-10-02T11:00:00Z', app: { id: 1 }, workflow_run: { id: 1 } },
      { status: 'completed', conclusion: 'timed_out', updated_at: '2026-10-02T11:30:00Z', app: { id: 1 }, workflow_run: { id: 1 } },
    ]);
    expect(r).toEqual({ lifecycle: 'ci_green', redSinceMs: null });
  });

  it('different workflows: failure in one is not masked by pass in another', () => {
    const r = checksFromSuites([
      { status: 'completed', conclusion: 'failure', updated_at: '2026-10-02T11:00:00Z', app: { id: 1 }, workflow_run: { id: 1 } },
      { status: 'completed', conclusion: 'success', updated_at: '2026-10-02T11:59:00Z', app: { id: 2 }, workflow_run: { id: 2 } },
    ]);
    expect(r).toEqual({ lifecycle: 'ci_failed', redSinceMs: Date.parse('2026-10-02T11:00:00Z') });
  });

  it('red since the newest failed suite completed (same workflow)', () => {
    const r = checksFromSuites([
      { status: 'completed', conclusion: 'failure', updated_at: '2026-10-02T11:59:00Z', app: { id: 1 }, workflow_run: { id: 1 } },
      { status: 'completed', conclusion: 'success', updated_at: '2026-10-02T11:00:00Z', app: { id: 1 }, workflow_run: { id: 1 } },
      { status: 'completed', conclusion: 'timed_out', updated_at: '2026-10-02T11:30:00Z', app: { id: 1 }, workflow_run: { id: 1 } },
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

  // Regression: both suites report the same GitHub Actions app (15368), but are
  // from different workflows (different workflow_run.id). They must not be
  // collapsed, so a failure in one workflow is not masked by a pass in another.
  it('same app.id, different workflows: failure not masked (GitHub Actions)', () => {
    const r = checksFromSuites([
      { status: 'completed', conclusion: 'failure', updated_at: '2026-10-02T11:00:00Z', app: { id: 15368 }, workflow_run: { id: 100 } },
      { status: 'completed', conclusion: 'success', updated_at: '2026-10-02T11:05:00Z', app: { id: 15368 }, workflow_run: { id: 101 } },
    ]);
    expect(r).toEqual({ lifecycle: 'ci_failed', redSinceMs: Date.parse('2026-10-02T11:00:00Z') });
  });

  it('same app.id, same workflow: newest suite determines verdict', () => {
    const r = checksFromSuites([
      { status: 'completed', conclusion: 'failure', updated_at: '2026-10-02T11:00:00Z', app: { id: 15368 }, workflow_run: { id: 100 } },
      { status: 'completed', conclusion: 'success', updated_at: '2026-10-02T11:05:00Z', app: { id: 15368 }, workflow_run: { id: 100 } },
    ]);
    expect(r).toEqual({ lifecycle: 'ci_green', redSinceMs: null });
  });
});
