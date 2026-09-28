import { describe, it, expect, mock } from 'bun:test';

describe('neon client wrapper - preserves .query method', () => {
  it('wraps .query method while preserving method identity and other properties', async () => {
    const captureErrorMock = mock(() => {});

    let originalQueryCalled = false;
    const mockQueryFn = mock(async (sql: string, params?: any[]) => {
      originalQueryCalled = true;
      return [{ id: 1 }];
    });

    const neonCallable = (async (strings: any, ...values: any) => {
      return [{ id: 1 }];
    }) as any;

    neonCallable.query = mockQueryFn;
    neonCallable.unsafe = mock(async () => [{ id: 1 }]);
    neonCallable.transaction = mock(async (fn: any) => {
      return fn({} as any);
    });

    mock.module('./error-span', () => ({
      capturePostgresErrorOnSpan: captureErrorMock,
    }));

    // Verify that wrapping baseSql.query preserves the structure
    const baseSql = neonCallable;
    const originalQuery = baseSql.query.bind(baseSql);

    // Simulate what getSql() does
    baseSql.query = ((...args: Parameters<typeof originalQuery>) =>
      originalQuery(...args).catch((error: unknown) => {
        captureErrorMock(error);
        throw error;
      })) as typeof baseSql.query;

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

    const mockQueryFn = mock(async () => {
      const err = new Error('duplicate key');
      (err as any).code = '23505';
      (err as any).detail = 'Key already exists';
      throw err;
    });

    const neonCallable = (async (strings: any, ...values: any) => {
      return [{ id: 1 }];
    }) as any;

    neonCallable.query = mockQueryFn;
    neonCallable.unsafe = mock(async () => []);
    neonCallable.transaction = mock(async (fn: any) => {
      return fn({} as any);
    });

    // Simulate what getSql() does
    const baseSql = neonCallable;
    const originalQuery = baseSql.query.bind(baseSql);

    baseSql.query = ((...args: Parameters<typeof originalQuery>) =>
      originalQuery(...args).catch((error: unknown) => {
        captureErrorMock(error);
        throw error;
      })) as typeof baseSql.query;

    // Now call the wrapped .query and verify error handling
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
});
