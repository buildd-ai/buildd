import { describe, it, expect, afterAll } from 'bun:test';
import { assertTestDatabaseSafe, ALLOW_REMOTE_TEST_DB_ENV } from '../db/test-guard';

const REMOTE = 'postgresql://user:secret@db.example.com/app?sslmode=require';
const LOCAL = 'postgresql://user:secret@127.0.0.1:5432/app';

describe('assertTestDatabaseSafe', () => {
  it('throws for a remote host under NODE_ENV=test', () => {
    expect(() => assertTestDatabaseSafe(REMOTE, { NODE_ENV: 'test' })).toThrow(/non-local database/);
  });

  it('never echoes the password in the error', () => {
    try {
      assertTestDatabaseSafe(REMOTE, { NODE_ENV: 'test' });
    } catch (err) {
      expect((err as Error).message).not.toContain('secret');
    }
  });

  it('throws for an unparseable URL under test', () => {
    expect(() => assertTestDatabaseSafe('not a url', { NODE_ENV: 'test' })).toThrow(/unparseable/);
  });

  it('allows loopback hosts under test', () => {
    expect(() => assertTestDatabaseSafe(LOCAL, { NODE_ENV: 'test' })).not.toThrow();
    expect(() => assertTestDatabaseSafe('postgres://u:p@localhost/db', { NODE_ENV: 'test' })).not.toThrow();
  });

  it('allows a remote host with the explicit opt-in', () => {
    expect(() =>
      assertTestDatabaseSafe(REMOTE, { NODE_ENV: 'test', [ALLOW_REMOTE_TEST_DB_ENV]: '1' }),
    ).not.toThrow();
  });

  it('is inert outside tests', () => {
    expect(() => assertTestDatabaseSafe(REMOTE, { NODE_ENV: 'production' })).not.toThrow();
    expect(() => assertTestDatabaseSafe(REMOTE, { NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertTestDatabaseSafe(REMOTE, {})).not.toThrow();
  });
});

describe('db client wiring', () => {
  const saved = { url: process.env.DATABASE_URL, allow: process.env[ALLOW_REMOTE_TEST_DB_ENV] };
  afterAll(() => {
    if (saved.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.url;
    if (saved.allow === undefined) delete process.env[ALLOW_REMOTE_TEST_DB_ENV];
    else process.env[ALLOW_REMOTE_TEST_DB_ENV] = saved.allow;
  });

  it('the real client refuses a remote DATABASE_URL in a test process', async () => {
    // config reads DATABASE_URL at import, so set it before the first import.
    process.env.DATABASE_URL = REMOTE;
    delete process.env[ALLOW_REMOTE_TEST_DB_ENV];
    expect(process.env.NODE_ENV).toBe('test');
    const { db } = await import('../db/client');
    expect(() => (db as any).select).toThrow(/non-local database/);
  });
});
