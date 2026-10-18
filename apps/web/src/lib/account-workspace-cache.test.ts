import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createFakeRedis } from './caller-cache.fixtures';

// Mock database
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const fakeRedis = createFakeRedis();

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

mock.module('./redis', () => fakeRedis.module);

import {
  getAccountWorkspacePermissions,
  invalidateAccountWorkspaceCache,
  invalidateWorkspacePermissionsCache,
} from './account-workspace-cache';
import { clearCallerCache, callerDep } from './caller-cache';

beforeEach(() => {
  mockAccountWorkspacesFindMany.mockReset();
  mockAccountWorkspacesFindMany.mockResolvedValue([]);
  fakeRedis.reset();
});

describe('getAccountWorkspacePermissions', () => {
  it('returns permissions from DB on first call', async () => {
    mockAccountWorkspacesFindMany.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
      { workspaceId: 'ws-2', canClaim: true, canCreate: true },
    ]);

    const result = await getAccountWorkspacePermissions('account-1');
    expect(result).toEqual([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
      { workspaceId: 'ws-2', canClaim: true, canCreate: true },
    ]);
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(1);
  });

  it('serves subsequent calls from the cache', async () => {
    mockAccountWorkspacesFindMany.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true, canCreate: false }]);

    await getAccountWorkspacePermissions('account-1');
    const result = await getAccountWorkspacePermissions('account-1');

    expect(result).toEqual([{ workspaceId: 'ws-1', canClaim: true, canCreate: false }]);
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(1);
  });

  it('caches separately per account', async () => {
    mockAccountWorkspacesFindMany
      .mockResolvedValueOnce([{ workspaceId: 'ws-1', canClaim: true, canCreate: false }])
      .mockResolvedValueOnce([{ workspaceId: 'ws-2', canClaim: false, canCreate: true }]);

    expect(await getAccountWorkspacePermissions('acct-1')).toEqual([{ workspaceId: 'ws-1', canClaim: true, canCreate: false }]);
    expect(await getAccountWorkspacePermissions('acct-2')).toEqual([{ workspaceId: 'ws-2', canClaim: false, canCreate: true }]);
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(2);
  });

  it('caches an account with no links, and a new link is seen once its write clears it', async () => {
    expect(await getAccountWorkspacePermissions('acct-1')).toEqual([]);
    expect(await getAccountWorkspacePermissions('acct-1')).toEqual([]);
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(1);

    mockAccountWorkspacesFindMany.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true, canCreate: true }]);
    await invalidateAccountWorkspaceCache('acct-1');
    expect(await getAccountWorkspacePermissions('acct-1')).toEqual([{ workspaceId: 'ws-1', canClaim: true, canCreate: true }]);
  });

  it('reads the DB on every call when Redis is down', async () => {
    fakeRedis.state.down = true;
    await getAccountWorkspacePermissions('acct-1');
    await getAccountWorkspacePermissions('acct-1');
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(2);
  });
});

describe('cache invalidation', () => {
  it('invalidateAccountWorkspaceCache forces a re-query for that account only', async () => {
    mockAccountWorkspacesFindMany.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true, canCreate: false }]);
    await getAccountWorkspacePermissions('acct-1');
    await getAccountWorkspacePermissions('acct-2');
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(2);

    await invalidateAccountWorkspaceCache('acct-1');
    await getAccountWorkspacePermissions('acct-1');
    await getAccountWorkspacePermissions('acct-2');
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(3);
  });

  it('invalidateWorkspacePermissionsCache re-reads every account linked to that workspace', async () => {
    mockAccountWorkspacesFindMany
      .mockResolvedValueOnce([{ workspaceId: 'ws-1', canClaim: true, canCreate: false }])
      .mockResolvedValueOnce([{ workspaceId: 'ws-2', canClaim: true, canCreate: false }])
      .mockResolvedValue([]);
    await getAccountWorkspacePermissions('acct-1');
    await getAccountWorkspacePermissions('acct-2');

    await invalidateWorkspacePermissionsCache('ws-1');
    await getAccountWorkspacePermissions('acct-1');
    await getAccountWorkspacePermissions('acct-2');
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(3);
  });

  it('an account change (deletion) clears its links too', async () => {
    await getAccountWorkspacePermissions('acct-1');
    await clearCallerCache(callerDep.account('acct-1'));
    await getAccountWorkspacePermissions('acct-1');
    expect(mockAccountWorkspacesFindMany).toHaveBeenCalledTimes(2);
  });
});
