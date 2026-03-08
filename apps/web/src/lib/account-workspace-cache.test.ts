import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock database
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);

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

import {
  getAccountWorkspacePermissions,
  invalidateAccountWorkspaceCache,
  invalidateWorkspacePermissionsCache,
  clearAccountWorkspaceCache,
} from './account-workspace-cache';

describe('getAccountWorkspacePermissions', () => {
  beforeEach(() => {
    mockAccountWorkspacesFindMany.mockReset();
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
});

describe('cache invalidation', () => {
  beforeEach(() => {
    mockAccountWorkspacesFindMany.mockReset();
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
