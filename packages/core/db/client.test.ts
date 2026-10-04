import { describe, it, expect, mock } from 'bun:test';
import { neon, NeonQueryPromise } from '@neondatabase/serverless';
import { wrapNeonQuery } from './query-wrapper';

// A real neon client: building a query does no I/O, so these run offline.
const client = () => neon('postgres://u:p@127.0.0.1:1/none');

describe('wrapNeonQuery', () => {
  it('returns the lazy NeonQueryPromise itself, so db.batch can compose it', () => {
    const sql = wrapNeonQuery(client(), () => {});
    const q = sql.query('SELECT 1');
    expect(q).toBeInstanceOf(NeonQueryPromise);
  });

  it('transaction() accepts wrapped queries (the regression: it threw synchronously)', async () => {
    const sql = wrapNeonQuery(client(), () => {});
    const err = await sql.transaction([sql.query('SELECT 1'), sql.query('SELECT 2')]).catch(e => e as Error);
    // Fails on the network (nothing listens), never on composition.
    expect(String(err)).not.toContain('transaction() expects an array of queries');
  });

  it('does not run the query until it is awaited', () => {
    const sql = wrapNeonQuery(client(), () => {});
    const q = sql.query('SELECT 1') as unknown as { execute: (...a: unknown[]) => Promise<unknown> };
    const spy = mock(q.execute);
    q.execute = spy;
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports a failed query to onError, then rethrows it', async () => {
    const onError = mock(() => {});
    const err = new Error('duplicate key');
    const fake = {
      query: () => ({ execute: () => Promise.reject(err), then(this: any, f: any, r: any) { return this.execute().then(f, r); } }),
    };
    const wrapped = wrapNeonQuery(fake, onError);
    let thrown: unknown;
    try { await wrapped.query(); } catch (e) { thrown = e; }
    expect(thrown).toBe(err);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('keeps the callable form and sibling methods', () => {
    const sql = wrapNeonQuery(client(), () => {});
    expect(typeof sql).toBe('function');
    expect(typeof sql.transaction).toBe('function');
    expect(typeof sql.unsafe).toBe('function');
  });
});
