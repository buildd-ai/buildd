/**
 * The task-PR read (task-pr.ts) rendered through PgDialect: the SQL a route test with a stubbed
 * drizzle cannot see. The behaviour on real rows is apps/web/tests/db/task-pr-derived.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { TASKS_TABLE_REF, taskHasPrSql, taskPrJsonSql, taskPrNumberSql, taskPrUrlSql, withTaskPr } from './task-pr';

const render = (q: SQL) => new PgDialect().sqlToQuery(q);

describe('taskPrJsonSql', () => {
  it('reads the owner\'s delivery first, then attempt rows before placeholders, then the stored result', () => {
    const { sql: text } = render(taskPrJsonSql());
    const delivery = text.indexOf('FROM workflow_deliveries tpd');
    const workersAt = text.indexOf('FROM workers tpw');
    const stored = text.indexOf(`->>'prNumber' ~ '^[0-9]+$'`);
    expect(delivery).toBeGreaterThan(0);
    expect(workersAt).toBeGreaterThan(delivery);
    expect(stored).toBeGreaterThan(workersAt);
    // Only the task that owns the delivery reads its PR.
    expect(text).toContain('tpd.owner_task_id = "tasks"."id"');
    expect(text).toContain('tpd.id = "tasks"."delivery_id"');
    // Placeholder rows sort last, then newest first.
    expect(text).toMatch(/ORDER BY \(tpw\.runner IS NOT NULL AND tpw\.runner = ANY\(string_to_array\(\$\d+::text, ','\)\)\) ASC, tpw\.created_at DESC, tpw\.id DESC/);
  });

  it('a single-table select gets qualified columns, so a bare id never binds to the subquery row', () => {
    const { sql: text } = render(taskPrNumberSql(TASKS_TABLE_REF));
    expect(text).toContain('tpw.task_id = "tasks"."id"');
    expect(text).not.toMatch(/tpw\.task_id = "id"/);
  });

  it('the scalar readers wrap the same jsonb', () => {
    expect(render(taskPrNumberSql()).sql).toMatch(/->>'prNumber'\)::int$/);
    expect(render(taskPrUrlSql()).sql).toMatch(/->>'prUrl'\)$/);
    expect(render(taskHasPrSql()).sql).toMatch(/\) IS NOT NULL\)$/);
  });
});

describe('withTaskPr', () => {
  it('lays the PR over the result and keeps every other key; no PR keeps the result as stored', () => {
    expect(withTaskPr({ summary: 's', prNumber: 1 }, { prUrl: 'u', prNumber: 2 })).toEqual({ summary: 's', prUrl: 'u', prNumber: 2 });
    const stored = { summary: 's', prUrl: 'old' };
    expect(withTaskPr(stored, null)).toBe(stored);
    expect(withTaskPr(null, { prUrl: null, prNumber: null })).toBeNull();
  });
});
