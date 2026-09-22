import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { dependentCountQuery } from './dependent-count-query';

// Rendered against the real dialect, because the defect this guards was
// invisible to every other kind of test: the route's own suite replaces
// drizzle-orm with object builders, so the fragment was never rendered and the
// invalid SQL only failed in production.
const render = (ids: string[]) => new PgDialect().sqlToQuery(dependentCountQuery(ids));

describe('dependentCountQuery', () => {
  const ids = ['id-one', 'id-two', 'id-three'];

  it('renders a parameterised IN list, never ANY over a parameter list', () => {
    const { sql: text } = render(ids);
    expect(text).toContain('in (');
    // The shipped bug. `ANY(($1, $2, $3))` is a row constructor; ANY needs an
    // array, so Postgres rejects the statement outright.
    expect(text).not.toContain('any(');
    expect(text).not.toContain('ANY(');
  });

  it('passes every id as a bound parameter, not as SQL text', () => {
    const { sql: text, params } = render(ids);
    expect(params).toEqual(ids);
    for (const id of ids) expect(text).not.toContain(id);
  });

  it('quotes the real column and keeps the lateral expansion', () => {
    const { sql: text } = render(ids);
    expect(text).toContain('"depends_on"');
    expect(text).toContain('jsonb_array_elements_text');
    // A bare `dependsOn` would be folded to lower case by Postgres and raise
    // undefined_column — the same defect class as this file's own bug.
    expect(text).not.toContain('dependsOn');
  });

  it('scales its parameter count with the id list', () => {
    expect(render(['only-one']).params).toHaveLength(1);
    expect(render(ids).params).toHaveLength(3);
  });
});
