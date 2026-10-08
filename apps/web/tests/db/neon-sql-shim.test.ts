/**
 * scripts/ci/neon-sql-shim.ts against REAL Postgres, driven by the real
 * @neondatabase/serverless driver. CI's db-architecture job runs the whole
 * suite through that shim instead of the local neon-http proxy, so this pins
 * the behaviours where a stand-in could quietly differ from production:
 * types, batch atomicity, error fields, the extended protocol, and one fresh
 * session per request.
 *
 * Starts its own shim instance, so it tests the shim whatever endpoint
 * NEON_LOCAL_FETCH_ENDPOINT names.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { neon, neonConfig } from '@neondatabase/serverless';
import { createNeonSqlShim } from '../../../../scripts/ci/neon-sql-shim';
import { assertDbConfigured } from './harness';

assertDbConfigured();

const shim = createNeonSqlShim();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => shim.fetch(req) });
neonConfig.fetchEndpoint = () => `http://127.0.0.1:${server.port}/sql`;

const sql = neon(process.env.DATABASE_URL!);
const table = `shim_probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  await sql.query(`CREATE TABLE ${table} (id int PRIMARY KEY, note text NOT NULL)`);
});
afterAll(async () => {
  await sql.query(`DROP TABLE IF EXISTS ${table}`);
  server.stop();
  await shim.close();
});

describe('neon-sql-shim on real Postgres', () => {
  test('types: jsonb, timestamptz, bigint, arrays, bool, numeric, uuid, null', async () => {
    const [row]: any[] = await sql.query(
      `SELECT $1::jsonb AS j, $2::timestamptz AS ts, 9007199254740993::bigint AS big,
              $3::int[] AS ints, ARRAY['a', 'b c']::text[] AS texts, true AS b,
              1.50::numeric AS num, '00000000-0000-0000-0000-000000000001'::uuid AS u, NULL::text AS n`,
      [JSON.stringify({ x: [1, 2] }), new Date('2026-01-02T03:04:05.678Z'), [1, 2]],
    );
    expect(row.j).toEqual({ x: [1, 2] });
    expect((row.ts as Date).toISOString()).toBe('2026-01-02T03:04:05.678Z');
    expect(row.big).toBe('9007199254740993');
    expect(row.ints).toEqual([1, 2]);
    expect(row.texts).toEqual(['a', 'b c']);
    expect(row.b).toBe(true);
    expect(row.num).toBe('1.50');
    expect(row.u).toBe('00000000-0000-0000-0000-000000000001');
    expect(row.n).toBeNull();
  });

  test('a multi-statement string is refused, as the proxy (extended protocol) refuses it', async () => {
    const err: any = await sql.query('SELECT 1; SELECT 2').catch((e) => e);
    expect(err.name).toBe('NeonDbError');
    expect(err.code).toBe('42601');
  });

  test('full results report command and rowCount', async () => {
    const r: any = await sql.query(`INSERT INTO ${table} VALUES (100, 'a'), (101, 'b')`, [], { fullResults: true });
    expect(r.command).toBe('INSERT');
    expect(r.rowCount).toBe(2);
  });

  test('a batch commits atomically', async () => {
    await sql.transaction([sql`INSERT INTO ${sql.unsafe(table)} VALUES (1, 'one')`, sql`INSERT INTO ${sql.unsafe(table)} VALUES (2, 'two')`]);
    const rows = await sql.query(`SELECT id FROM ${table} WHERE id IN (1, 2) ORDER BY id`);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test('a failing batch rolls back every statement and throws the Postgres error fields', async () => {
    const err: any = await sql
      .transaction([sql`INSERT INTO ${sql.unsafe(table)} VALUES (3, 'three')`, sql`INSERT INTO ${sql.unsafe(table)} VALUES (1, 'dup')`])
      .catch((e) => e);
    expect(err.name).toBe('NeonDbError');
    expect(err.code).toBe('23505');
    expect(err.severity).toBe('ERROR');
    expect(err.table).toBe(table);
    expect(err.schema).toBe('public');
    expect(err.constraint).toBe(`${table}_pkey`);
    expect(err.detail).toContain('(id)=(1)');
    expect(typeof err.routine).toBe('string');
    expect(await sql.query(`SELECT id FROM ${table} WHERE id = 3`)).toEqual([]);
  });

  test('a not-null violation names its column', async () => {
    const err: any = await sql.query(`INSERT INTO ${table} VALUES (9, NULL)`).catch((e) => e);
    expect(err.code).toBe('23502');
    expect(err.column).toBe('note');
  });

  test('each request is a fresh session: SET, temp tables and advisory locks do not leak', async () => {
    // Run each probe many times so a reused pooled connection would be hit.
    for (let i = 0; i < 5; i++) {
      await sql.query(`SET application_name = 'leaked'`);
      const [s]: any[] = await sql.query(`SELECT current_setting('application_name') AS app`);
      expect(s.app).not.toBe('leaked');

      await sql.query(`CREATE TEMP TABLE shim_leak_${i} (a int)`);
      const [t]: any[] = await sql.query(`SELECT to_regclass('pg_temp.shim_leak_${i}') AS rel`);
      expect(t.rel).toBeNull();

      await sql.query('SELECT pg_advisory_lock(424242)');
      const [l]: any[] = await sql.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 424242`);
      expect(l.n).toBe(0);
    }
  });

  test('a lone BEGIN does not leave the next request inside a transaction', async () => {
    await sql.query('BEGIN');
    // Inside one open transaction every request would see the same xid.
    const xids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const [r]: any[] = await sql.query(`SELECT txid_current()::text AS xid`);
      xids.add(r.xid);
    }
    expect(xids.size).toBe(5);
  });
});
