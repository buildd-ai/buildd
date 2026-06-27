import { describe, it, expect, beforeEach, mock, afterAll} from 'bun:test';

// Mock database
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);

// Mock Redis — default to no-ops so existing L1 tests are unaffected
const mockGetCachedAccountWorkspaces = mock(() => Promise.resolve(null) as any);
const mockSetCachedAccountWorkspaces = mock(() => Promise.resolve());
const mockInvalidateCachedAccountWorkspaces = mock(() => Promise.resolve());

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accountWorkspaces: { accountId: 'accountId', workspaceId: 'workspaceId' },
}));

mock.module('./redis', () => ({
  getCachedAccountWorkspaces: mockGetCachedAccountWorkspaces,
  setCachedAccountWorkspaces: mockSetCachedAccountWorkspaces,
  invalidateCachedAccountWorkspaces: mockInvalidateCachedAccountWorkspaces,
}));

import {
  getAccountWorkspacePermissions,
  invalidateAccountWorkspaceCache,
  invalidateWorkspacePermissionsCache,
  clearAccountWorkspaceCache,
} from './account-workspace-cache';

describe('getAccountWorkspacePermissions', () => {
  beforeEach(() => {
    mockAccountWorkspacesFindMany.mockReset();
    mockGetCachedAccountWorkspaces.mockReset();
    mockSetCachedAccountWorkspaces.mockReset();
    mockInvalidateCachedAccountWorkspaces.mockReset();
    mockGetCachedAccountWorkspaces.mockResolvedValue(null);
    mockSetCachedAccountWorkspaces.mockResolvedValue(undefined);
    mockInvalidateCachedAccountWorkspaces.mockResolvedValue(undefined);
    clearAccountWorkspaceCache();
  });

  it('returns permissions from DB on first call', async () => {
    const dbRows = [
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
      { workspaceId: 'ws-2', canClaim: true, canCreate: true },
    ];
    mockAccountWorkspacesFindMany.mockResolvedValue(dbRows);

    const result = await getAccountWorkspacePermissions('account-1');

    expect(result).toEqual([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
      { workspaceId: 'ws-2', canClaim: true, canCreate: true },
    ]);
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(1);
  });

  it('serves subsequent calls from cache', async () => {
    const dbRows = [{ workspaceId: 'ws-1', canClaim: true, canCreate: false }];
    mockAccountWorkspacesFindMany.mockResolvedValue(dbRows);

    await getAccountWorkspacePermissions('account-1');
    const result = await getAccountWorkspacePermissions('account-1');

    expect(result).toEqual([{ workspaceId: 'ws-1', canClaim: true, canCreate: false }]);
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(1);
  });

  it('caches separately per account', async () => {
    mockAccountWorkspacesFindMany
      .mockResolvedValueOnce([{ workspaceId: 'ws-1', canClaim: true, canCreate: false }])
      .mockResolvedValueOnce([{ workspaceId: 'ws-2', canClaim: false, canCreate: true }]);

    const r1 = await getAccountWorkspacePermissions('acct-1');
    const r2 = await getAccountWorkspacePermissions('acct-2');

    expect(r1).toEqual([{ workspaceId: 'ws-1', canClaim: true, canCreate: false }]);
    expect(r2).toEqual([{ workspaceId: 'ws-2', canClaim: false, canCreate: true }]);
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(2);
  });

  it('returns empty array for accounts with no workspaces', async () => {
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    const result = await getAccountWorkspacePermissions('no-workspaces');
    expect(result).toEqual([]);
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(1);
  });

  it('returns permissions from Redis L2 without hitting DB (cold L1)', async () => {
    const redisPerms = [{ workspaceId: 'ws-redis', canClaim: true, canCreate: false }];
    mockGetCachedAccountWorkspaces.mockResolvedValueOnce(redisPerms);

    const result = await getAccountWorkspacePermissions('acct-redis');

    expect(result).toEqual(redisPerms);
    expect(mockAccountWorkspacesFindMany).not.toHaveBeenCalled();
  });

  it('populates L1 from Redis hit so next call skips both Redis and DB', async () => {
    const redisPerms = [{ workspaceId: 'ws-warm', canClaim: true, canCreate: true }];
    mockGetCachedAccountWorkspaces.mockResolvedValueOnce(redisPerms);

    await getAccountWorkspacePermissions('acct-warm');
    const result2 = await getAccountWorkspacePermissions('acct-warm');

    expect(result2).toEqual(redisPerms);
    expect(mockGetCachedAccountWorkspaces).toHaveBeenCalledTimes(1);
    expect(mockAccountWorkspacesFindMany).not.toHaveBeenCalled();
  });

  it('writes to Redis after DB hit', async () => {
    const dbRows = [{ workspaceId: 'ws-db', canClaim: true, canCreate: false }];
    mockAccountWorkspacesFindMany.mockResolvedValueOnce(dbRows);

    await getAccountWorkspacePermissions('acct-db');

    expect(mockSetCachedAccountWorkspaces).toHaveBeenCalledTimes(1);
  });
});

describe('cache invalidation', () => {
  beforeEach(() => {
    mockAccountWorkspacesFindMany.mockReset();
    mockGetCachedAccountWorkspaces.mockReset();
    mockSetCachedAccountWorkspaces.mockReset();
    mockInvalidateCachedAccountWorkspaces.mockReset();
    mockGetCachedAccountWorkspaces.mockResolvedValue(null);
    mockSetCachedAccountWorkspaces.mockResolvedValue(undefined);
    mockInvalidateCachedAccountWorkspaces.mockResolvedValue(undefined);
    clearAccountWorkspaceCache();
  });

  it('invalidateAccountWorkspaceCache forces re-query for that account', async () => {
    const dbRows = [{ workspaceId: 'ws-1', canClaim: true, canCreate: false }];
    mockAccountWorkspacesFindMany.mockResolvedValue(dbRows);

    await getAccountWorkspacePermissions('acct-1');
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(1);

    invalidateAccountWorkspaceCache('acct-1');

    await getAccountWorkspacePermissions('acct-1');
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(2);
  });

  it('invalidateAccountWorkspaceCache does not affect other accounts', async () => {
    mockAccountWorkspacesFindMany
      .mockResolvedValueOnce([{ workspaceId: 'ws-1', canClaim: true, canCreate: false }])
      .mockResolvedValueOnce([{ workspaceId: 'ws-2', canClaim: true, canCreate: true }]);

    await getAccountWorkspacePermissions('acct-1');
    await getAccountWorkspacePermissions('acct-2');
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(2);

    invalidateAccountWorkspaceCache('acct-1');

    // acct-2 should still be cached
    await getAccountWorkspacePermissions('acct-2');
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(2);
  });

  it('invalidateAccountWorkspaceCache also fires Redis invalidation', () => {
    invalidateAccountWorkspaceCache('acct-redis-inv');
    expect(mockInvalidateCachedAccountWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('clearAccountWorkspaceCache empties all entries', async () => {
    mockAccountWorkspacesFindMany.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);

    await getAccountWorkspacePermissions('acct-1');
    await getAccountWorkspacePermissions('acct-2');
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(2);

    clearAccountWorkspaceCache();

    await getAccountWorkspacePermissions('acct-1');
    await getAccountWorkspacePermissions('acct-2');
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(4);
  });
});

afterAll(() => mock.restore());
