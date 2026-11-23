import { describe, it, expect, afterAll } from 'bun:test';
import { neon, neonConfig, NeonQueryPromise } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { NEON_RAW_TEXT_TYPES, withRawTextTypes } from './neon-raw-text';

const parse = (oid: number, text: string) => NEON_RAW_TEXT_TYPES.getTypeParser(oid, 'text')(text);

describe('NEON_RAW_TEXT_TYPES (the rc.4 raw-row shape)', () => {
  // drizzle-orm rc.4's neon-http driver set these parsers globally; rc.6 dropped that.
  it.each([
    ['timestamptz', 1184, '2026-11-22 19:51:53.045+00'],
    ['timestamp', 1114, '2026-11-22 19:51:53.045'],
    ['date', 1082, '2026-11-22'],
    ['interval', 1186, '01:00:00'],
    ['timestamptz[]', 1185, '{"2026-11-22 19:51:53+00"}'],
    ['timestamp[]', 1115, '{"2026-11-22 19:51:53"}'],
    ['date[]', 1182, '{2026-11-22}'],
    ['interval[]', 1187, '{01:00:00}'],
    ['numeric[]', 1231, '{1.50,2}'],
  ])('returns %s as the text Postgres sent', (_name, oid, text) => {
    expect(parse(oid as number, text as string)).toBe(text);
  });

  it('leaves every other type to the client default parser', () => {
    expect(parse(23, '42')).toBe(42); // int4
    expect(parse(16, 't')).toBe(true); // bool
    expect(parse(3802, '{"a":1}')).toEqual({ a: 1 }); // jsonb
  });
});

// A canned neon HTTP response: one row with a uuid and a timestamptz, in the
// row shape the request asked for. No network.
const AT = '2026-11-22 19:51:53.045+00';
const originalFetch = neonConfig.fetchFunction;
neonConfig.fetchFunction = async (_url: string, init: { body: string; headers: Record<string, string> }) => {
  const arrayMode = init.headers['Neon-Array-Mode'] === 'true';
  const one = {
    command: 'SELECT',
    rowCount: 1,
    rowAsArray: arrayMode,
    fields: [{ name: 'id', dataTypeID: 2950 }, { name: 'at', dataTypeID: 1184 }],
    rows: [['00000000-0000-0000-0000-000000000001', AT]],
  };
  const body = JSON.parse(init.body);
  const payload = body.queries ? { results: body.queries.map(() => one) } : one;
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
};
afterAll(() => {
  neonConfig.fetchFunction = originalFetch;
});

const t = pgTable('t', { id: uuid('id'), at: timestamp('at', { withTimezone: true }) });
const url = 'postgres://u:p@db.example.test/none';

describe('withRawTextTypes through drizzle neon-http', () => {
  it('without it, drizzle rc.6 hands raw db.execute rows a Date (the behaviour change)', async () => {
    const db = drizzle({ client: neon(url) });
    const raw = await db.execute(sql`select id, at from t`);
    expect(raw.rows[0]!.at).toBeInstanceOf(Date);
  });

  it('raw db.execute rows keep timestamptz as text, as on rc.4', async () => {
    const db = drizzle({ client: withRawTextTypes(neon(url)) });
    const raw = await db.execute(sql`select id, at from t`);
    expect(raw.rows[0]!.at).toBe(AT);
  });

  it('codec-decoded selects still return Date', async () => {
    const db = drizzle({ client: withRawTextTypes(neon(url)) });
    const [row] = await db.select().from(t);
    expect(row!.at).toBeInstanceOf(Date);
    expect(row!.at!.toISOString()).toBe('2026-11-22T19:51:53.045Z');
  });

  it('db.batch keeps raw rows as text and still runs as one transaction', async () => {
    const db = drizzle({ client: withRawTextTypes(neon(url)) });
    const [a, b] = await db.batch([db.execute(sql`select id, at from t`), db.execute(sql`select id, at from t`)]);
    expect((a as any).rows[0].at).toBe(AT);
    expect((b as any).rows[0].at).toBe(AT);
  });

  it('returns the lazy NeonQueryPromise, so batch can compose it', () => {
    const client = withRawTextTypes(neon(url));
    expect(client.query('SELECT 1')).toBeInstanceOf(NeonQueryPromise);
  });

  it('leaves a query that already names its types alone', async () => {
    const own = { getTypeParser: () => (v: string) => `own:${v}` };
    const client = withRawTextTypes(neon(url));
    const res = await client.query('select', [], { types: own, fullResults: true });
    expect((res as any).rows[0].at).toBe(`own:${AT}`);
  });
});
