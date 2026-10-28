/**
 * database.query on real Postgres (docs/specs/database-query-agent-capability.md).
 *
 * The broker's SQL check refuses writes and other tables before anything is
 * sent; this suite proves the two layers below it hold on their own, by
 * sending statements the check would have refused straight to the executor:
 * the role from scripts/query-role-grants.ts reads only the allowlist, and the
 * READ ONLY transaction plus the subquery wrap refuse every write.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { QueryExecutionError, wrapWithRowCap } from '@/lib/capability-database-query';
import { readOnlyQueryExecutor } from '@/lib/capability-database-query-store';
import { queryRoleGrantStatements } from '../../../../scripts/query-role-grants';
import { assertDbConfigured, q } from './harness';

const ROLE = 'buildd_query_ro_dbtest';
let exec: NonNullable<ReturnType<typeof readOnlyQueryExecutor>>;

beforeAll(async () => {
  assertDbConfigured();
  const password = randomBytes(12).toString('hex');
  const [{ exists }] = await q<{ exists: boolean }>(sql.raw(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') AS exists`));
  await q(sql.raw(exists ? `ALTER ROLE ${ROLE} LOGIN PASSWORD '${password}'` : `CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}'`));
  for (const s of queryRoleGrantStatements(ROLE)) await q(sql.raw(s));
  const url = new URL(process.env.DATABASE_URL!);
  url.username = ROLE;
  url.password = password;
  exec = readOnlyQueryExecutor(url.toString())!;
});

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as QueryExecutionError);

describe('the read-only query role', () => {
  test('reads an allowlisted table', async () => {
    const out = await exec(wrapWithRowCap('select count(*)::int as n from tasks', 10), []);
    expect(out.fields).toEqual(['n']);
    expect(typeof out.rows[0].n).toBe('number');
  });

  test('a table outside the allowlist is refused by privilege', async () => {
    const err = await refusal(exec(wrapWithRowCap('select count(*) from secrets', 10), []));
    expect(err).toBeInstanceOf(QueryExecutionError);
    expect(err!.sqlstate).toBe('42501');
  });

  test('INSERT, UPDATE and DDL fail in Postgres itself', async () => {
    for (const stmt of [
      "insert into gate_events (id) values (gen_random_uuid())",
      "update tasks set title = title",
      'create table buildd_query_probe (id int)',
      'drop table tasks',
    ]) {
      const err = await refusal(exec(stmt, []));
      expect(err, stmt).toBeInstanceOf(QueryExecutionError);
    }
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'buildd_query_probe'`);
    expect(n).toBe(0);
  });

  test('a data-modifying CTE cannot run under the row-cap wrap', async () => {
    const err = await refusal(exec(wrapWithRowCap('with d as (delete from tasks where false returning id) select * from d', 10), []));
    expect(err).toBeInstanceOf(QueryExecutionError);
  });
});
