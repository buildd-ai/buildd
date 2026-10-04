/**
 * Render check for the dependency-wake statement. Its behaviour (which
 * dependents it wakes) is covered against real Postgres in
 * apps/web/tests/db/dependency-wake.test.ts; this pins the shape a mocked
 * driver would hide: one statement, parent bound as a parameter, and the
 * outbox write spliced into the same CTE chain.
 */
import { describe, expect, it } from 'bun:test';
import { sql as sqlTag } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { enqueueReadyDependentsSql } from '../dispatch-dependents';

const PARENT = '11111111-1111-4111-8111-111111111111';
// Stand-in for the claim route's depsGate(): the statement must splice
// whatever gate it is given, not carry a readiness rule of its own.
const GATE = sqlTag`claim_gate_marker(tasks.id)`;

describe('enqueueReadyDependentsSql', () => {
  const { sql, params } = new PgDialect().sqlToQuery(enqueueReadyDependentsSql(PARENT, GATE));

  it('binds the parent id instead of inlining it', () => {
    expect(params).toEqual([PARENT, 'dependency.satisfied', 'dependency.satisfied']);
    expect(sql).not.toContain(PARENT);
    expect(sql).toContain('jsonb_build_array($1::text)');
  });

  it('selects ready pending dependents and writes their intents in one statement', () => {
    expect(sql.match(/-- dispatch_dependents:enqueue_ready/g)).toHaveLength(1);
    expect(sql).toContain("tasks.status = 'pending'");
    expect(sql).toContain('INSERT INTO task_dispatch_outbox');
    expect(sql).toContain('FROM "ready" s JOIN tasks t');
    expect(sql.trim().endsWith('SELECT task_id FROM wake')).toBe(true);
  });

  it('uses the gate it is given as the readiness rule, guarded against malformed ids', () => {
    expect(sql).toContain('THEN claim_gate_marker(tasks.id) ELSE false END');
    expect(sql).not.toContain('loop_state');
    // Guarded cast: a malformed id must block, not abort the statement.
    expect(sql).toMatch(/WHERE d\.dep_id !~ '\^\[0-9a-fA-F\]\{8\}/);
  });
});
