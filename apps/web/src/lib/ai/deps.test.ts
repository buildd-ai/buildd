/**
 * The account daily budget's spend filter, rendered: buildd's own decision
 * receipts (surface 'decision') are attributed to the account for audit but
 * never counted against its budget.
 */
import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { accountDaySpendWhere } = await import('./deps');

const dialect = new PgDialect();

describe('accountDaySpendWhere', () => {
  it('counts the account since the day start, excluding decision receipts', () => {
    const dayStart = new Date('2026-09-28T00:00:00Z');
    const q = dialect.sqlToQuery(accountDaySpendWhere('acct-1', dayStart)!);
    const text = q.sql.replace(/\s+/g, ' ');
    expect(text).toContain('"ai_usage"."account_id" = $1');
    expect(text).toContain('"ai_usage"."created_at" >= $2');
    expect(text).toContain(`"ai_usage"."surface" IS DISTINCT FROM 'decision'`);
    expect(q.params[0]).toBe('acct-1');
  });
});
