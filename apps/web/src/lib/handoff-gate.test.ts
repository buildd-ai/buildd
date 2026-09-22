import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { unfinishedDependentPredicate } from './handoff-gate';

/**
 * The handoff completion gate refuses a task that has downstream dependents and
 * no `structuredOutput.handoff.delivered`. Its whole behaviour hinges on one
 * `WHERE`: "does any other task depend on me".
 *
 * That predicate cannot be tested through the route's own test file. The route
 * test replaces `drizzle-orm` wholesale with plain object builders, so `sql` is
 * a stub that records its template and never renders anything — a wrong column
 * name is literally unobservable there. The gate also runs inside a
 * deliberately fail-open `try/catch`, so a predicate that throws at the
 * database reads exactly like a task with no dependents: completion proceeds,
 * nothing is logged at the assertion level, and the gate reports no opinion.
 *
 * Three layers of invisibility over one identifier. So this test renders the
 * predicate with the real dialect and asserts on the SQL text, which is the
 * only place the column name is actually decided.
 */
describe('unfinishedDependentPredicate', () => {
  const dialect = new PgDialect();
  const taskId = '11111111-2222-3333-4444-555555555555';
  const render = () => dialect.sqlToQuery(unfinishedDependentPredicate(taskId)!);

  it('filters on the tasks.depends_on column, not the camelCase property name', () => {
    const { sql } = render();

    // `depends_on` is the column; `dependsOn` is the Drizzle property. A raw
    // fragment emits whatever text it is given, and Postgres folds an unquoted
    // identifier to lowercase — so `dependsOn` reaches the server as
    // `dependson`, which does not exist, and every execution throws 42703.
    expect(sql).toContain('"tasks"."depends_on"');
    expect(sql).not.toContain('dependsOn');
    expect(sql).not.toContain('dependson');
  });

  it('asks for jsonb containment of the task id', () => {
    const { sql, params } = render();

    expect(sql).toContain('@>');
    expect(sql).toContain('::jsonb');
    // Parameterised, not interpolated into the SQL text.
    expect(params).toContain(JSON.stringify([taskId]));
    expect(sql).not.toContain(taskId);
  });

  it('ignores cancelled dependents', () => {
    const { sql, params } = render();

    expect(sql).toContain('"tasks"."status"');
    expect(params).toContain('cancelled');
  });
});
