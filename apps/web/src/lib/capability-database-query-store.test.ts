import { describe, expect, it } from 'bun:test';
import { DATABASE_QUERY_LIMITS, DATABASE_QUERY_TABLES, QueryExecutionError } from './capability-database-query';
import { readOnlyQueryExecutor, schemaTableNames } from './capability-database-query-store';

type Sent = { text: string; params?: unknown[] };

function fakeNeon(fail?: { message: string; code: string }) {
  const calls: { queries: Sent[]; opts: Record<string, unknown> }[] = [];
  const sql = {
    query: (text: string, params?: unknown[]) => ({ text, params }),
    transaction: async (queries: Sent[], opts: Record<string, unknown>) => {
      calls.push({ queries, opts });
      if (fail) throw Object.assign(new Error(fail.message), { code: fail.code });
      return [{ rows: [] }, { rows: [] }, { rows: [{ id: 'x' }], fields: [{ name: 'id' }] }];
    },
  };
  return { make: () => sql as never, calls };
}

describe('readOnlyQueryExecutor', () => {
  it('no read-only role configured: no executor, so the broker refuses', () => {
    expect(readOnlyQueryExecutor(undefined)).toBeNull();
    expect(readOnlyQueryExecutor('')).toBeNull();
  });

  it('runs the statement in a READ ONLY transaction behind statement and lock timeouts', async () => {
    const f = fakeNeon();
    const exec = readOnlyQueryExecutor('postgres://buildd_query_ro@db/neondb', f.make)!;
    const out = await exec('SELECT * FROM (\nselect id from tasks\n) AS buildd_query LIMIT 3', ['a']);
    expect(out).toEqual({ rows: [{ id: 'x' }], fields: ['id'] });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].opts).toMatchObject({ readOnly: true });
    expect(f.calls[0].queries.map(q => q.text)).toEqual([
      `SET LOCAL statement_timeout = ${DATABASE_QUERY_LIMITS.statementTimeoutMs}`,
      `SET LOCAL lock_timeout = ${DATABASE_QUERY_LIMITS.lockTimeoutMs}`,
      'SELECT * FROM (\nselect id from tasks\n) AS buildd_query LIMIT 3',
    ]);
    expect(f.calls[0].queries[2].params).toEqual(['a']);
  });

  it("surfaces Postgres's refusal with its SQLSTATE", async () => {
    const f = fakeNeon({ message: 'cannot execute INSERT in a read-only transaction', code: '25006' });
    const exec = readOnlyQueryExecutor('postgres://x@db/neondb', f.make)!;
    const err = await exec('select 1', []).catch(e => e);
    expect(err).toBeInstanceOf(QueryExecutionError);
    expect(err.sqlstate).toBe('25006');
  });
});

describe('schemaTableNames', () => {
  it('names every schema table, so an off-allowlist one is refused by name', () => {
    const names = schemaTableNames();
    expect(names).toContain('secrets');
    expect(names).toContain('accounts');
    // The allowlist names real tables: a rename would silently drop forensics access.
    for (const t of DATABASE_QUERY_TABLES) expect(names).toContain(t);
  });
});
