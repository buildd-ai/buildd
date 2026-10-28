import { describe, expect, it } from 'bun:test';
import {
  DATABASE_QUERY_LIMITS,
  DATABASE_QUERY_TABLES,
  QueryExecutionError,
  checkReadOnlySql,
  parseDatabaseQueryRequest,
  runDatabaseQuery,
  wrapWithRowCap,
  type DatabaseQueryDeps,
  type QueryAuditRow,
  type QueryParam,
} from './capability-database-query';

const KNOWN = [...DATABASE_QUERY_TABLES, 'secrets', 'accounts', 'users', 'capability_grants'];
const check = (sql: string) => checkReadOnlySql(sql, { allowedTables: DATABASE_QUERY_TABLES, knownTables: KNOWN });
const PRINCIPAL = { teamId: 'team-1', workspaceId: 'ws-1', taskId: 'task-1', workerId: 'worker-1' };
const GRANT = { ok: true as const, grantId: 'grant-1', expiresAt: new Date('2026-10-28T12:00:00Z') };

function harness(over: Partial<DatabaseQueryDeps> = {}) {
  const audits: QueryAuditRow[] = [];
  const sent: { sql: string; params: QueryParam[] }[] = [];
  let t = 1_000;
  const deps: DatabaseQueryDeps = {
    findGrant: async () => GRANT,
    execute: async (sql, params) => {
      sent.push({ sql, params });
      t += 42;
      return { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], fields: ['id'] };
    },
    knownTables: KNOWN,
    audit: row => audits.push(row),
    now: () => t,
    ...over,
  };
  return { deps, audits, sent };
}
const req = (sql: string, maxRows = 200) => ({ sql, params: [] as QueryParam[], maxRows });

describe('checkReadOnlySql', () => {
  it('accepts a SELECT and a WITH … SELECT over allowlisted tables', () => {
    expect(check('select id, status from tasks where status = $1;').ok).toBe(true);
    expect(check(`WITH m AS (SELECT id FROM missions) SELECT t.id FROM tasks t JOIN m ON m.id = t.mission_id`).ok).toBe(true);
    expect(check('select count(*) from workflow_transitions, gate_events').ok).toBe(true);
  });

  it.each([
    ['insert into tasks (id) values (1)'],
    ['UPDATE tasks SET status = $1'],
    ['delete from tasks'],
    ['drop table tasks'],
    ['create table x (id int)'],
    ['alter table tasks add column x int'],
    ['truncate tasks'],
    ['grant select on secrets to public'],
    ['copy tasks to stdout'],
    ['set role neondb_owner'],
    ['TABLE tasks'],
    ['explain analyze delete from tasks'],
  ])('a read grant cannot run %s', sql => {
    const r = check(sql);
    expect(r.ok).toBe(false);
  });

  it('refuses writes hidden in a SELECT: a data-modifying CTE, SELECT INTO, FOR UPDATE', () => {
    expect(check('with d as (delete from tasks returning id) select * from d')).toMatchObject({ ok: false, code: 'write_keyword' });
    expect(check('select * into tasks_copy from tasks')).toMatchObject({ ok: false, code: 'write_keyword' });
    expect(check('select * from tasks for update')).toMatchObject({ ok: false, code: 'write_keyword' });
  });

  it('refuses a second statement, even after a comment or a string', () => {
    expect(check('select 1 from tasks; delete from tasks')).toMatchObject({ ok: false });
    expect(check("select ';' from tasks; select 1")).toMatchObject({ ok: false, code: 'multiple_statements' });
  });

  it('a table outside the allowlist is refused, however it is named', () => {
    for (const sql of [
      'select * from secrets',
      'select * from public.secrets',
      'select * from "secrets"',
      'select t.id from tasks t, accounts a',
      'select * from tasks where id in (select task_id from capability_grants)',
      'select * from tasks join users on true',
    ]) expect(check(sql)).toMatchObject({ ok: false, code: 'table_not_allowed' });
  });

  it('refuses system catalogs and SQL-from-a-string functions', () => {
    expect(check('select * from pg_catalog.pg_roles')).toMatchObject({ ok: false, code: 'system_catalog' });
    expect(check('select * from information_schema.tables')).toMatchObject({ ok: false, code: 'system_catalog' });
    expect(check('select pg_sleep(100) from tasks')).toMatchObject({ ok: false, code: 'system_catalog' });
    expect(check("select query_to_xml('select * from secrets', true, true, '') from tasks")).toMatchObject({ ok: false, code: 'function_not_allowed' });
    expect(check("select set_config('role', 'neondb_owner', true) from tasks")).toMatchObject({ ok: false, code: 'function_not_allowed' });
  });

  it('ignores names in strings and comments; strips trailing semicolons', () => {
    const r = check("select id from tasks where title = 'delete from secrets' -- drop table secrets\n;;");
    expect(r).toEqual({ ok: true, sql: "select id from tasks where title = 'delete from secrets' -- drop table secrets" });
    expect(check('select $$ insert $$ from tasks').ok).toBe(true);
  });

  it('refuses unterminated input', () => {
    expect(check("select 'x from tasks")).toMatchObject({ ok: false, code: 'unterminated' });
    expect(check('select 1 /* from tasks')).toMatchObject({ ok: false, code: 'unterminated' });
  });
});

describe('wrapWithRowCap', () => {
  it('wraps as a subquery under cap + 1, a line comment cannot swallow the close', () => {
    expect(wrapWithRowCap('select 1 from tasks -- x', 50)).toBe('SELECT * FROM (\nselect 1 from tasks -- x\n) AS buildd_query LIMIT 51');
  });
});

describe('parseDatabaseQueryRequest', () => {
  it('takes sql, params and maxRows; refuses plumbing', () => {
    expect(parseDatabaseQueryRequest({ sql: 'select 1', params: ['a', 1, null], maxRows: 10 })).toEqual({ ok: true, request: { sql: 'select 1', params: ['a', 1, null], maxRows: 10 } });
    expect(parseDatabaseQueryRequest({ sql: 'select 1' })).toEqual({ ok: true, request: { sql: 'select 1', params: [], maxRows: DATABASE_QUERY_LIMITS.defaultRows } });
    expect(parseDatabaseQueryRequest({ sql: 'select 1', connectionString: 'postgres://x' }).ok).toBe(false);
    expect(parseDatabaseQueryRequest({ sql: 'select 1', maxRows: DATABASE_QUERY_LIMITS.maxRows + 1 }).ok).toBe(false);
    expect(parseDatabaseQueryRequest({ sql: 'select 1', params: [{}] }).ok).toBe(false);
    expect(parseDatabaseQueryRequest({}).ok).toBe(false);
  });
});

describe('runDatabaseQuery', () => {
  it('with no grant answers with the request_capability step and sends nothing', async () => {
    const h = harness({ findGrant: async () => ({ ok: false, reasonCode: 'no_grant' }) });
    const out = await runDatabaseQuery(PRINCIPAL, req('select id from tasks'), h.deps);
    expect(out).toMatchObject({ ok: false, status: 403, code: 'no_grant', requestWith: { tool: 'request_capability', params: { provider: 'neon', access: 'read' } } });
    expect(h.sent).toHaveLength(0);
    expect(h.audits).toEqual([{ decision: 'refused', grantId: null, reasonCode: 'no_grant', expiresAt: null, sideEffect: { sql: 'select id from tasks', sqlTruncated: false, rowCount: null, durationMs: null } }]);
  });

  it('a granted run still cannot send INSERT, UPDATE or DDL', async () => {
    for (const sql of ['insert into tasks (id) values (1)', 'update tasks set status = $1', 'drop table tasks', 'with d as (delete from tasks returning id) select * from d']) {
      const h = harness();
      const out = await runDatabaseQuery(PRINCIPAL, req(sql), h.deps);
      expect(out.ok).toBe(false);
      expect(h.sent).toHaveLength(0);
      expect(h.audits[0]).toMatchObject({ decision: 'refused', grantId: 'grant-1', sideEffect: { sql } });
    }
  });

  it('a table outside the allowlist is refused before anything is sent', async () => {
    const h = harness();
    const out = await runDatabaseQuery(PRINCIPAL, req('select * from secrets'), h.deps);
    expect(out).toMatchObject({ ok: false, status: 400, code: 'table_not_allowed' });
    expect(h.sent).toHaveLength(0);
    expect(h.audits[0]).toMatchObject({ decision: 'refused', reasonCode: 'table_not_allowed' });
  });

  it('no read-only role configured: refuses, never falls back', async () => {
    const h = harness({ execute: null });
    const out = await runDatabaseQuery(PRINCIPAL, req('select id from tasks'), h.deps);
    expect(out).toMatchObject({ ok: false, status: 503, code: 'query_role_unconfigured' });
    expect(h.audits[0]).toMatchObject({ decision: 'refused', reasonCode: 'query_role_unconfigured' });
  });

  it('runs under the row cap and records SQL, row count and duration, never the rows', async () => {
    const h = harness();
    const out = await runDatabaseQuery(PRINCIPAL, { sql: 'select id from tasks where status = $1', params: ['failed'], maxRows: 2 }, h.deps);
    expect(out).toEqual({ ok: true, rows: [{ id: 'a' }, { id: 'b' }], fields: ['id'], rowCount: 2, truncated: true, durationMs: 42, grantId: 'grant-1' });
    expect(h.sent).toEqual([{ sql: wrapWithRowCap('select id from tasks where status = $1', 2), params: ['failed'] }]);
    expect(h.audits).toEqual([{
      decision: 'allowed', grantId: 'grant-1', reasonCode: null, expiresAt: GRANT.expiresAt,
      sideEffect: { sql: 'select id from tasks where status = $1', sqlTruncated: false, rowCount: 2, durationMs: 42, truncated: true },
    }]);
    expect(JSON.stringify(h.audits)).not.toContain('"a"');
  });

  it('every query is on the trail: one audit row per call, success or Postgres refusal', async () => {
    const h = harness();
    let calls = 0;
    h.deps.execute = async () => {
      calls++;
      if (calls === 2) throw new QueryExecutionError('cannot execute INSERT in a read-only transaction', '25006');
      if (calls === 3) throw new QueryExecutionError('canceling statement due to statement timeout', '57014');
      return { rows: [], fields: [] };
    };
    const a = await runDatabaseQuery(PRINCIPAL, req('select 1 from tasks'), h.deps);
    const b = await runDatabaseQuery(PRINCIPAL, req('select 2 from tasks'), h.deps);
    const c = await runDatabaseQuery(PRINCIPAL, req('select 3 from tasks'), h.deps);
    await runDatabaseQuery(PRINCIPAL, req('select * from secrets'), h.deps);
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, code: 'query_failed' });
    expect(c).toMatchObject({ ok: false, code: 'statement_timeout' });
    expect(h.audits.map(r => [r.decision, r.reasonCode, r.sideEffect.sql])).toEqual([
      ['allowed', null, 'select 1 from tasks'],
      ['refused', 'query_failed', 'select 2 from tasks'],
      ['refused', 'statement_timeout', 'select 3 from tasks'],
      ['refused', 'table_not_allowed', 'select * from secrets'],
    ]);
    expect(h.audits[1].sideEffect.sqlstate).toBe('25006');
  });

  it('cuts very long SQL on the trail and marks it', async () => {
    const h = harness();
    const sql = `select id from tasks where title in (${Array.from({ length: 2_000 }, (_, i) => `'t${i}'`).join(',')})`;
    await runDatabaseQuery(PRINCIPAL, req(sql), h.deps);
    expect(h.audits[0].sideEffect.sql.length).toBe(DATABASE_QUERY_LIMITS.auditSqlChars);
    expect(h.audits[0].sideEffect.sqlTruncated).toBe(true);
  });
});
