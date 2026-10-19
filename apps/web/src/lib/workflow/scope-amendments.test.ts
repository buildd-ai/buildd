/**
 * The scope amendment statements rendered through the real PgDialect
 * (scripts/sql-render-coverage.test.ts). Behaviour on a real database is
 * apps/web/tests/db/scope-amendments.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { planScope, planScopeResolution } from '@buildd/workflow-kernel/scope-amendments';
import { recordScopeSql, resolveScopeSql, scopeAmendmentsSql } from './scope-amendments';

const dialect = new PgDialect();
const mission = { description: 'd', goalCriteria: [{ type: 'all_prs_merged' }], scopeVersion: 4 };
const task = { id: 't', title: 'T' };
const base = { missionId: 'm', taskId: 't', factId: null, deciderId: 'd@1', confidence: 0.9, fallback: null, actor: 'test' };

describe('scope amendment SQL', () => {
  it('reads a mission set as uuids', () => {
    const { sql } = dialect.sqlToQuery(scopeAmendmentsSql(['m']));
    expect(sql).toContain('FROM workflow_scope_amendments');
    expect(sql).toContain('::uuid)');
  });

  it('an applied amendment moves the mission only at the version it read, then the open delivery with no PR, then the row', () => {
    const { sql, params } = dialect.sqlToQuery(recordScopeSql({ ...base, plan: planScope({ verdict: 'amend_scope', reason: 'r', mission, task }), hold: null }));
    expect(sql).toMatch(/UPDATE missions SET description = \$\d+::text, goal_criteria = \$\d+::jsonb,\s+scope_version = \$\d+::int/);
    expect(sql).toMatch(/AND scope_version = \$\d+::int\s+AND NOT EXISTS \(SELECT 1 FROM workflow_scope_amendments/);
    expect(sql).toContain("state = 'open' AND pr_number IS NULL AND EXISTS (SELECT 1 FROM m)");
    expect(sql).toContain('ON CONFLICT (mission_id, source_task_id) DO NOTHING');
    expect(params).toContain(4);
    expect(params).toContain(5);
  });

  it('a held decision writes the row, the task hold and one question, all gated on the row', () => {
    const plan = planScope({ verdict: 'ask', reason: 'unclear', mission, task });
    const { sql } = dialect.sqlToQuery(recordScopeSql({ ...base, plan, hold: { at: '2026-10-15T00:00:00.000Z', noteTitle: 'q', noteBody: 'b' } }));
    expect(sql).toContain("jsonb_build_object('heldBy'");
    expect(sql).toContain("WHERE id = $");
    expect(sql).toContain("AND status = 'pending' AND EXISTS (SELECT 1 FROM a)");
    expect(sql).toContain("'system', 'question'");
    expect(sql).not.toContain('UPDATE missions');
  });

  it('an answer resolves only a held row, releases only this mission\'s hold and answers the question', () => {
    const plan = planScopeResolution({ answer: 'out_of_scope', held: { status: 'held' }, mission, task });
    if (!plan.act) throw new Error('expected a plan');
    const { sql } = dialect.sqlToQuery(resolveScopeSql({ missionId: 'm', taskId: 't', plan, actor: 'human:p' }));
    expect(sql).toContain("SET status = 'resolved', resolution = $");
    expect(sql).toContain("AND status = 'held'");
    expect(sql).toMatch(/COALESCE\(t\.context->'heldBy'->>'missionId', \$\d+::text\) = \$\d+::text/);
    expect(sql).toContain("UPDATE mission_notes SET status = 'answered'");
    expect(sql).not.toContain('UPDATE missions');
  });

  it('an accepted amendment moves the mission only at the version it read, and only while the decision is held', () => {
    const plan = planScopeResolution({ answer: 'amend_scope', held: { status: 'held' }, mission, task });
    if (!plan.act) throw new Error('expected a plan');
    const { sql, params } = dialect.sqlToQuery(resolveScopeSql({ missionId: 'm', taskId: 't', plan, actor: 'human:p' }));
    expect(sql).toMatch(/AND scope_version = \$\d+::int AND EXISTS \(SELECT 1 FROM workflow_scope_amendments/);
    expect(sql).toContain("state = 'open' AND pr_number IS NULL AND EXISTS (SELECT 1 FROM m)");
    expect(sql).toContain("AND status = 'held' AND EXISTS (SELECT 1 FROM m)");
    expect(params).toContain(4);
    expect(params).toContain(5);
  });
});
