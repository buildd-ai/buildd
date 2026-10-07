/**
 * The shim against a FAKE pool, decoded by the REAL @neondatabase/serverless
 * driver — so what is pinned here is the wire contract (request parsing, the
 * response/error JSON the driver reads, the transaction statements a batch
 * issues), not Postgres. Behaviour against real Postgres is
 * apps/web/tests/db/neon-sql-shim.test.ts (`bun run test:db`).
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { neon, neonConfig } from '@neondatabase/serverless';
import { createNeonSqlShim, toWireError, NEON_ERROR_FIELDS, type ShimClient, type ShimPool } from './neon-sql-shim';

type Field = { name: string; dataTypeID: number };
type Canned = { fields?: Field[]; rows?: unknown[][]; command?: string; rowCount?: number | null } | Error;

const log: Array<{ text: string; values?: unknown[]; queryMode?: string; rowMode?: string }> = [];
let respond: (text: string, values?: unknown[]) => Canned = () => ({});
const released: Array<boolean | Error | undefined> = [];
const poolsMade: string[] = [];

function fakeClient(): ShimClient {
  return {
    async query(cfg) {
      log.push({ text: cfg.text, values: cfg.values, queryMode: cfg.queryMode, rowMode: cfg.rowMode });
      const r = respond(cfg.text, cfg.values);
      if (r instanceof Error) throw r;
      return {
        fields: (r.fields ?? []).map((f) => ({ ...f, tableID: 0, columnID: 0, dataTypeSize: -1, dataTypeModifier: -1, format: 'text' })),
        rows: r.rows ?? [],
        command: r.command ?? 'SELECT',
        rowCount: r.rowCount === undefined ? (r.rows?.length ?? 0) : r.rowCount,
      };
    },
    release(destroy) {
      released.push(destroy);
    },
  };
}

const shim = createNeonSqlShim({
  poolFactory: (cs): ShimPool => {
    poolsMade.push(cs);
    return { connect: async () => fakeClient(), end: async () => {} };
  },
});

const ENDPOINT = 'http://shim.test/sql';
neonConfig.fetchEndpoint = () => ENDPOINT;
neonConfig.fetchFunction = (url: string, init: RequestInit) => shim.fetch(new Request(url, init));

const CS = 'postgres://demo:demo@localhost:5432/buildd_test';
const sql = neon(CS);

function pgError(fields: Record<string, string>): Error {
  return Object.assign(new Error(fields.message), fields);
}

beforeEach(() => {
  log.length = 0;
  released.length = 0;
  respond = () => ({});
});
afterAll(() => shim.close());

describe('single query', () => {
  test('sends text + params over the extended protocol in raw array mode', async () => {
    respond = () => ({ fields: [{ name: 'a', dataTypeID: 25 }], rows: [['hi']] });
    const rows = await sql.query('select $1 as a', ['hi']);
    expect(rows).toEqual([{ a: 'hi' }]);
    expect(log[0]).toEqual({ text: 'select $1 as a', values: ['hi'], queryMode: 'extended', rowMode: 'array' });
  });

  test('a parameterless query still goes over the extended protocol (no multi-statement strings)', async () => {
    await sql.query('select 1');
    expect(log[0].queryMode).toBe('extended');
  });

  test('full results carry command, rowCount and fields', async () => {
    respond = () => ({ command: 'INSERT', rowCount: 2, rows: [] });
    const r: any = await sql.query('insert into t values (1),(2)', [], { fullResults: true });
    expect(r.command).toBe('INSERT');
    expect(r.rowCount).toBe(2);
    expect(r.rows).toEqual([]);
  });

  test('a command without a row count reports null, as the proxy does', async () => {
    respond = () => ({ command: 'CREATE', rowCount: null });
    const r: any = await sql.query('create table t(a int)', [], { fullResults: true });
    expect(r.rowCount).toBeNull();
  });

  test('every request resets its session and returns the client healthy', async () => {
    await sql.query('select 1');
    expect(log.map((l) => l.text)).toEqual(['select 1', 'DISCARD ALL']);
    expect(released).toEqual([undefined]);
  });

  test('a session that cannot be reset (open transaction) is destroyed, not pooled', async () => {
    respond = (text) => (text === 'DISCARD ALL' ? pgError({ message: 'DISCARD ALL cannot run inside a transaction block', code: '25001' }) : {});
    await sql.query('begin');
    expect(released).toEqual([true]);
  });
});

describe('types — raw text decoded by the driver per dataTypeID', () => {
  test('jsonb, timestamptz, bigint, int[], text[], bool, bytea, null', async () => {
    respond = () => ({
      fields: [
        { name: 'j', dataTypeID: 3802 },
        { name: 'ts', dataTypeID: 1184 },
        { name: 'big', dataTypeID: 20 },
        { name: 'ints', dataTypeID: 1007 },
        { name: 'texts', dataTypeID: 1009 },
        { name: 'b', dataTypeID: 16 },
        { name: 'bytes', dataTypeID: 17 },
        { name: 'n', dataTypeID: 25 },
      ],
      rows: [['{"x": [1, 2]}', '2026-01-02 03:04:05.678+00', '9007199254740993', '{1,2}', '{a,"b c"}', 't', '\\x0102', null]],
    });
    const [row]: any[] = await sql.query('select …');
    expect(row.j).toEqual({ x: [1, 2] });
    expect(row.ts).toBeInstanceOf(Date);
    expect((row.ts as Date).toISOString()).toBe('2026-01-02T03:04:05.678Z');
    expect(row.big).toBe('9007199254740993');
    expect(row.ints).toEqual([1, 2]);
    expect(row.texts).toEqual(['a', 'b c']);
    expect(row.b).toBe(true);
    expect(Buffer.from(row.bytes).toString('hex')).toBe('0102');
    expect(row.n).toBeNull();
  });

  test('params arrive as the driver serialised them (arrays, dates, json, null)', async () => {
    const when = new Date('2026-01-02T03:04:05.678Z');
    await sql.query('select $1, $2, $3, $4', [[1, 2], when, JSON.stringify({ a: 1 }), null]);
    const values = log[0].values!;
    expect(values[0]).toBe('{"1","2"}');
    expect(typeof values[1]).toBe('string');
    expect(new Date(values[1] as string).toISOString()).toBe(when.toISOString());
    expect(values[2]).toBe('{"a":1}');
    expect(values[3]).toBeNull();
  });

  test('duplicate column names survive in array mode', async () => {
    respond = () => ({ fields: [{ name: 'a', dataTypeID: 23 }, { name: 'a', dataTypeID: 23 }], rows: [['1', '2']] });
    const r = await sql.query('select 1 as a, 2 as a', [], { arrayMode: true });
    expect(r).toEqual([[1, 2]]);
  });
});

describe('batch — one transaction', () => {
  test('commits every statement inside BEGIN … COMMIT and returns results in order', async () => {
    respond = (text) => (text.startsWith('select') ? { fields: [{ name: 'x', dataTypeID: 23 }], rows: [['7']] } : { command: 'INSERT', rowCount: 1 });
    const [a, b] = await sql.transaction([sql`insert into t values (${1})`, sql`select 7 as x`]);
    expect(a).toEqual([]);
    expect(b).toEqual([{ x: 7 }]);
    expect(log.map((l) => l.text)).toEqual(['BEGIN', 'insert into t values ($1)', 'select 7 as x', 'COMMIT', 'DISCARD ALL']);
    expect(log[1].values).toEqual(['1']);
  });

  test('a failing statement rolls the whole batch back and throws a NeonDbError', async () => {
    respond = (text) => (text === 'boom' ? pgError({ message: 'division by zero', code: '22012', severity: 'ERROR' }) : {});
    const err: any = await sql.transaction([sql`insert into t values (1)`, sql.query('boom')]).catch((e) => e);
    expect(err.name).toBe('NeonDbError');
    expect(err.message).toBe('division by zero');
    expect(err.code).toBe('22012');
    expect(log.map((l) => l.text)).toEqual(['BEGIN', 'insert into t values (1)', 'boom', 'ROLLBACK', 'DISCARD ALL']);
    expect(released).toEqual([undefined]);
  });

  test('isolation level, read-only and deferrable headers shape the BEGIN', async () => {
    await sql.transaction([sql`select 1`], { isolationLevel: 'Serializable', readOnly: true, deferrable: true });
    expect(log[0].text).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE');
    log.length = 0;
    await sql.transaction([sql`select 1`], { isolationLevel: 'RepeatableRead', readOnly: false });
    expect(log[0].text).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
  });
});

describe('errors — the fields the driver copies onto NeonDbError', () => {
  test('every Postgres error field is carried, missing ones as undefined on the error', async () => {
    const fields = {
      message: 'duplicate key value violates unique constraint "t_pkey"',
      severity: 'ERROR', code: '23505', detail: 'Key (id)=(1) already exists.', hint: 'h', position: '12',
      internalPosition: '3', internalQuery: 'iq', where: 'w', schema: 'public', table: 't', column: 'id',
      dataType: 'integer', constraint: 't_pkey', file: 'nbtinsert.c', line: '666', routine: '_bt_check_unique',
    };
    respond = () => pgError(fields);
    const err: any = await sql.query('insert …').catch((e) => e);
    expect(err.name).toBe('NeonDbError');
    for (const [k, v] of Object.entries(fields)) expect(err[k]).toBe(v);

    respond = () => pgError({ message: 'relation "nope" does not exist', code: '42P01', severity: 'ERROR' });
    const bare: any = await sql.query('select * from nope').catch((e) => e);
    expect(bare.code).toBe('42P01');
    expect(bare.detail).toBeUndefined();
    expect(bare.constraint).toBeUndefined();
  });

  test('the 400 body lists exactly the driver fields, null where absent', () => {
    const body = toWireError(pgError({ message: 'm', code: '42P01' }))!;
    expect(Object.keys(body).sort()).toEqual(['message', ...NEON_ERROR_FIELDS].sort());
    expect(body.detail).toBeNull();
  });

  test('a non-Postgres failure is a non-400 the driver reports as a server error', async () => {
    respond = () => new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const err: any = await sql.query('select 1').catch((e) => e);
    expect(err.name).toBe('NeonDbError');
    expect(err.message).toContain('HTTP status 500');
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.code).toBeUndefined();
  });
});

describe('request guard', () => {
  const post = (headers: Record<string, string>, body: unknown = { query: 'select 1', params: [] }) =>
    shim.fetch(new Request(ENDPOINT, { method: 'POST', headers: { 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true', ...headers }, body: JSON.stringify(body) }));

  test('refuses a non-loopback database', async () => {
    const r = await post({ 'Neon-Connection-String': 'postgres://u:p@db.example.com:5432/x' });
    expect(r.status).toBe(403);
    expect(log).toEqual([]);
  });

  test('refuses a request without a connection string, or not in raw array mode', async () => {
    expect((await post({})).status).toBe(400);
    const r = await shim.fetch(new Request(ENDPOINT, { method: 'POST', headers: { 'Neon-Connection-String': CS }, body: '{"query":"select 1"}' }));
    expect(r.status).toBe(400);
  });

  test('one pool per connection string, so another database on the server is its own pool', async () => {
    const before = poolsMade.length;
    await post({ 'Neon-Connection-String': 'postgres://demo:demo@localhost:5432/other_db' });
    await post({ 'Neon-Connection-String': 'postgres://demo:demo@localhost:5432/other_db' });
    expect(poolsMade.slice(before)).toEqual(['postgres://demo:demo@localhost:5432/other_db']);
  });

  test('only POST /sql', async () => {
    const r = await shim.fetch(new Request('http://shim.test/other', { method: 'POST' }));
    expect(r.status).toBe(404);
  });
});
