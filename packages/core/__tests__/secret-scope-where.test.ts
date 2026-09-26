import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// Rendered with the real dialect, not a mocked db: a mocked db makes the
// predicate unobservable, and the predicate is the whole point here.
import { secretScopeWhere } from '../secrets/postgres-provider';

const dialect = new PgDialect();
function render(frag: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(frag as never);
  return { sql: q.sql.replace(/\s+/g, ' ').trim(), params: q.params };
}

describe('secretScopeWhere (replaceScoped delete scope)', () => {
  it('a team-scope save only touches rows with no user — it never deletes personal keys', () => {
    const { sql } = render(secretScopeWhere({ teamId: 't-1', purpose: 'inference_key', label: 'openrouter' }));
    expect(sql).toContain('"secrets"."user_id" is null');
    expect(sql).toContain('"secrets"."account_id" is null');
    expect(sql).toContain('"secrets"."workspace_id" is null');
  });

  it('a personal save only touches that user\'s row — it never deletes the team key', () => {
    const { sql, params } = render(secretScopeWhere({
      teamId: 't-1', purpose: 'inference_key', label: 'openrouter', userId: 'u-1',
    }));
    expect(sql).toContain('"secrets"."user_id" = $');
    expect(sql).not.toContain('"secrets"."user_id" is null');
    expect(params).toContain('u-1');
  });
});
