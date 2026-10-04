/**
 * Render check for the dependency-wake statement. Its behaviour (which
 * dependents it wakes) is covered against real Postgres in
 * apps/web/tests/db/dependency-wake.test.ts; this pins the shape a mocked
 * driver would hide: one statement, parent bound as a parameter, and the
 * outbox write spliced into the same CTE chain.
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { enqueueReadyDependentsSql } from '../dispatch-dependents';

const PARENT = '11111111-1111-4111-8111-111111111111';

describe('enqueueReadyDependentsSql', () => {
  const { sql, params } = new PgDialect().sqlToQuery(enqueueReadyDependentsSql(PARENT));

  it('binds the parent id instead of inlining it', () => {
    expect(params).toEqual([PARENT]);
    expect(sql).not.toContain(PARENT);
    expect(sql).toContain('jsonb_build_array($1::text)');
  });

  it('selects ready pending dependents and writes their intents in one statement', () => {
    expect(sql.match(/-- dispatch_dependents:enqueue_ready/g)).toHaveLength(1);
    expect(sql).toContain("c.status = 'pending'");
    expect(sql).toContain('INSERT INTO task_dispatch_outbox');
    expect(sql).toContain("'dependency.satisfied'");
    expect(sql).toContain('FROM ready s JOIN tasks t');
    expect(sql.trim().endsWith('SELECT task_id FROM wake')).toBe(true);
  });

  it('mirrors every part of the readiness rule', () => {
    expect(sql).toContain("p.status <> 'completed'");
    expect(sql).toContain("p.loop_state <> 'satisfied'");
    expect(sql).toContain('w.pr_url IS NOT NULL');
    expect(sql).toContain('ORDER BY w.created_at DESC LIMIT 1');
    expect(sql).toContain('latest_pr.merged_at IS NULL');
    // Guarded cast: a malformed id must block, not abort the statement.
    expect(sql).toMatch(/CASE WHEN d\.dep_id ~ '\^\[0-9a-fA-F\]\{8\}/);
  });
});
