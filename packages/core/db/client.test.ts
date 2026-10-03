import { describe, it, expect, mock } from 'bun:test';
import { NeonQueryPromise } from '@neondatabase/serverless';

// Mirrors the wrapping logic in ./client.ts getSql(). Duplicated here (not imported)
// because getSql() is gated behind a real DATABASE_URL and the test-database safety
// guard, so these tests exercise the same transform in isolation.
function wrapQuery(baseSql: any, captureError: (error: unknown) => void) {
  const originalQuery = baseSql.query.bind(baseSql);
  baseSql.query = ((...args: Parameters<typeof originalQuery>) => {
    const queryPromise = originalQuery(...args);
    const originalThen = queryPromise.then.bind(queryPromise);
    queryPromise.then = ((onFulfilled?: unknown, onRejected?: unknown) =>
      originalThen(onFulfilled, (error: unknown) => {
        captureError(error);
        if (typeof onRejected === 'function') return (onRejected as (e: unknown) => unknown)(error);
        throw error;
      })) as typeof queryPromise.then;
    return queryPromise;
  }) as typeof baseSql.query;
  return baseSql;
}

describe('neon client wrapper - preserves .query method', () => {
  it('wraps .query method while preserving method identity and other properties', async () => {
    const captureErrorMock = mock(() => {});

    const neonCallable = (async (strings: any, ...values: any) => {
      return [{ id: 1 }];
    }) as any;

    neonCallable.query = (sql: string, params: any[], opts: any) =>
      new NeonQueryPromise(async () => ({ rows: [{ id: 1 }] }), { query: sql, params }, opts);
    neonCallable.unsafe = mock(async () => [{ id: 1 }]);
    neonCallable.transaction = mock(async (fn: any) => {
      return fn({} as any);
    });

    const baseSql = wrapQuery(neonCallable, captureErrorMock);

    // After wrapping, verify the structure is preserved
    expect(typeof baseSql).toBe('function');
    expect(typeof baseSql.query).toBe('function');
    expect(typeof baseSql.unsafe).toBe('function');
    expect(typeof baseSql.transaction).toBe('function');
  });

  it('captures postgres error on .query rejection before rethrowing', async () => {
    let captureCallCount = 0;
    const captureErrorMock = mock((error: unknown) => {
      captureCallCount++;
    });

    const neonCallable = (async (strings: any, ...values: any) => {
      return [{ id: 1 }];
    }) as any;

    neonCallable.query = (sql: string, params: any[], opts: any) =>
      new NeonQueryPromise(
        async () => {
          const err = new Error('duplicate key');
          (err as any).code = '23505';
          (err as any).detail = 'Key already exists';
          throw err;
        },
        { query: sql, params },
        opts,
      );
    neonCallable.unsafe = mock(async () => []);
    neonCallable.transaction = mock(async (fn: any) => {
      return fn({} as any);
    });

    const baseSql = wrapQuery(neonCallable, captureErrorMock);

    try {
      await baseSql.query('INSERT INTO users VALUES ($1)', [123]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeDefined();
      expect((error as any).code).toBe('23505');
      expect((error as any).detail).toBe('Key already exists');
      expect(captureCallCount).toBe(1);
    }
  });

  it('keeps the wrapped .query() result instanceof NeonQueryPromise, so db.batch() still works', () => {
    // drizzle's neon-http `db.batch()` (packages/core/path-claim.ts's sole caller, for
    // every claim acquisition/narrowing/release) hands each built query straight to the
    // raw neon client's own `.transaction()`, which rejects anything that isn't
    // `instanceof NeonQueryPromise` with "transaction() expects an array of queries, or a
    // function returning an array of queries" -- the exact error repeatedly reported as
    // check_path_claim friction. A wrapper that calls `.catch()`/`.then()` directly on the
    // returned promise (rather than patching it in place) silently demotes it to a plain
    // Promise and breaks this for every call, regardless of whether the query succeeds.
    const neonCallable = (async () => []) as any;
    neonCallable.query = (sql: string, params: any[], opts: any) =>
      new NeonQueryPromise(async () => ({ rows: [] }), { query: sql, params }, opts);
    neonCallable.unsafe = mock(async () => []);
    neonCallable.transaction = mock(async () => []);

    const baseSql = wrapQuery(neonCallable, () => {});

    const result = baseSql.query('SELECT 1', []);
    expect(result instanceof NeonQueryPromise).toBe(true);
  });
});
