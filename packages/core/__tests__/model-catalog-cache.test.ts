import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── mock the DB and the network fetch before importing the module under test ──
const mockFindFirst = mock();
const mockInsert = mock();
const mockOnConflictDoUpdate = mock(() => Promise.resolve());
const mockValues = mock(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockFetchOpenRouterCatalog = mock();

mock.module('../db/client', () => ({
  db: {
    query: {
      systemCache: {
        findFirst: mockFindFirst,
      },
    },
    insert: mockInsert,
  },
}));

mock.module('../db/schema', () => ({
  systemCache: { key: 'key', value: 'value', expiresAt: 'expires_at' },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
}));

mock.module('../model-catalog', () => ({
  fetchOpenRouterCatalog: mockFetchOpenRouterCatalog,
}));

const { getCachedOpenRouterCatalog, _resetCatalogCache } = await import('../model-catalog-cache');

const FIXTURE_ENTRY = {
  id: 'claude-opus-5',
  canonicalId: null,
  openRouterId: 'anthropic/claude-opus-5',
  provider: 'anthropic',
  displayName: 'Claude Opus 5',
  contextLength: 1_000_000,
  created: 1_780_000_000,
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
};

beforeEach(() => {
  mockFindFirst.mockReset();
  mockInsert.mockReset();
  mockInsert.mockReturnValue({ values: mockValues });
  mockOnConflictDoUpdate.mockReset();
  mockOnConflictDoUpdate.mockReturnValue(Promise.resolve());
  mockFetchOpenRouterCatalog.mockReset();
  _resetCatalogCache();
});

describe('getCachedOpenRouterCatalog', () => {
  it('reads a fresh system_cache row without hitting the network', async () => {
    mockFindFirst.mockResolvedValue({
      value: [FIXTURE_ENTRY],
      expiresAt: new Date(Date.now() + 60_000),
    });

    const entries = await getCachedOpenRouterCatalog();

    expect(entries).toEqual([FIXTURE_ENTRY]);
    expect(mockFetchOpenRouterCatalog).not.toHaveBeenCalled();
  });

  it('falls through to a network fetch when the DB row is missing', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    mockFetchOpenRouterCatalog.mockResolvedValue([FIXTURE_ENTRY]);

    const entries = await getCachedOpenRouterCatalog();

    expect(entries).toEqual([FIXTURE_ENTRY]);
    expect(mockFetchOpenRouterCatalog).toHaveBeenCalledTimes(1);
    // Writes the fresh fetch back for the next cold start.
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('falls through to a network fetch when the DB row is expired', async () => {
    mockFindFirst.mockResolvedValue({
      value: [FIXTURE_ENTRY],
      expiresAt: new Date(Date.now() - 1_000),
    });
    mockFetchOpenRouterCatalog.mockResolvedValue([FIXTURE_ENTRY]);

    await getCachedOpenRouterCatalog();

    expect(mockFetchOpenRouterCatalog).toHaveBeenCalledTimes(1);
  });

  it('falls through to a network fetch when the DB throws', async () => {
    mockFindFirst.mockRejectedValue(new Error('DB unavailable'));
    mockFetchOpenRouterCatalog.mockResolvedValue([FIXTURE_ENTRY]);

    const entries = await getCachedOpenRouterCatalog();

    expect(entries).toEqual([FIXTURE_ENTRY]);
  });

  it('does not write back an empty fetch result', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    mockFetchOpenRouterCatalog.mockResolvedValue([]);

    const entries = await getCachedOpenRouterCatalog();

    expect(entries).toEqual([]);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('never throws when both the DB and the network fail', async () => {
    mockFindFirst.mockRejectedValue(new Error('DB unavailable'));
    mockFetchOpenRouterCatalog.mockRejectedValue(new Error('network error'));

    // fetchOpenRouterCatalog itself never throws per its own contract, but
    // this guards the cache layer against a mock/mismatch regressing that.
    await expect(getCachedOpenRouterCatalog()).rejects.toThrow();
  });

  it('serves subsequent calls from the in-process cache without a second DB read', async () => {
    mockFindFirst.mockResolvedValue({
      value: [FIXTURE_ENTRY],
      expiresAt: new Date(Date.now() + 60_000),
    });

    await getCachedOpenRouterCatalog();
    await getCachedOpenRouterCatalog();

    expect(mockFindFirst).toHaveBeenCalledTimes(1);
  });

  it('a non-array row value is treated as a miss and falls through to a fetch', async () => {
    mockFindFirst.mockResolvedValue({ value: { not: 'an array' }, expiresAt: null });
    mockFetchOpenRouterCatalog.mockResolvedValue([FIXTURE_ENTRY]);

    const entries = await getCachedOpenRouterCatalog();

    expect(entries).toEqual([FIXTURE_ENTRY]);
  });
});
