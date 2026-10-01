import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

const mockAuthenticateApiKey = mock((_key: string | null) => Promise.resolve(null as any));
const mockAccountsFindFirst = mock(() => Promise.resolve(null as any));

mock.module('./api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@buildd/core/db', () => ({
  db: { query: { accounts: { findFirst: mockAccountsFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({ accounts: { id: 'id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));

import { authenticateTaskScopedCaller, taskScopeAllowsTask, taskScopeAllowsWorker, taskScopeAllowsWorkspace } from './task-token-auth';
import { mintTaskToken } from './task-token';

const savedSecret = process.env.AUTH_SECRET;
afterAll(() => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
});

const ACCOUNT = { id: 'acct-1', teamId: 'team-1', level: 'admin', hostRunner: true, apiKey: 'hash-1' };
const MINT = { accountId: 'acct-1', taskId: 'task-1', workspaceId: 'ws-1', keyHash: 'hash-1' };

describe('authenticateTaskScopedCaller', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = 'test-secret';
    mockAuthenticateApiKey.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountsFindFirst.mockResolvedValue(ACCOUNT);
  });

  it('passes an account key straight to authenticateApiKey', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    const account = await authenticateTaskScopedCaller('bld_key');
    expect(account).toEqual(ACCOUNT as any);
    expect(mockAuthenticateApiKey).toHaveBeenCalledWith('bld_key');
  });

  it('resolves a task token to its account at worker level, never a host runner, with its task scope', async () => {
    const { token } = mintTaskToken(MINT)!;
    const account = await authenticateTaskScopedCaller(token);
    expect(account?.id).toBe('acct-1');
    expect(account?.level).toBe('worker');
    expect(account?.hostRunner).toBe(false);
    expect(account?.taskScope?.taskId).toBe('task-1');
    expect(account?.taskScope?.workspaceId).toBe('ws-1');
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
  });

  it('rejects a forged or expired task token without looking up the account', async () => {
    expect(await authenticateTaskScopedCaller('bldt_forged.sig')).toBeNull();
    const { token } = mintTaskToken({ ...MINT, ttlMs: 1000 }, Date.now() - 5000)!;
    expect(await authenticateTaskScopedCaller(token)).toBeNull();
    expect(mockAccountsFindFirst).not.toHaveBeenCalled();
  });

  it('forwards the request so a scoped account key gets its route checks', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    const request = { url: 'https://example.test/api/workers/claim', method: 'POST' };
    await authenticateTaskScopedCaller('bld_key', request);
    expect(mockAuthenticateApiKey).toHaveBeenCalledWith('bld_key', request);
  });

  it('a task token is never a scoped token: one whose minting account has scopes, or has expired, is refused', async () => {
    const { token } = mintTaskToken(MINT)!;
    mockAccountsFindFirst.mockResolvedValue({ ...ACCOUNT, scopes: ['admin'], workspaceIds: null });
    expect(await authenticateTaskScopedCaller(token)).toBeNull();
    mockAccountsFindFirst.mockResolvedValue({ ...ACCOUNT, scopes: null, expiresAt: new Date(Date.now() - 1000) });
    expect(await authenticateTaskScopedCaller(token)).toBeNull();
    mockAccountsFindFirst.mockResolvedValue({ ...ACCOUNT, scopes: null, expiresAt: null });
    expect((await authenticateTaskScopedCaller(token))?.scopes).toBeNull();
  });

  it('rejects a task token whose account is gone', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);
    const { token } = mintTaskToken(MINT)!;
    expect(await authenticateTaskScopedCaller(token)).toBeNull();
  });
});

describe('authenticateTaskScopedCaller — key rotation', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = 'test-secret';
    mockAccountsFindFirst.mockReset();
  });

  it('rejects a task token once the key that minted it is regenerated', async () => {
    mockAccountsFindFirst.mockResolvedValue({ ...ACCOUNT, apiKey: 'hash-rotated' });
    const { token } = mintTaskToken(MINT)!;
    expect(await authenticateTaskScopedCaller(token)).toBeNull();
  });
});

describe('task scope checks', () => {
  const scoped = { taskScope: { taskId: 'task-1', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };

  it('confines a scoped caller to its own task\'s workspace', () => {
    expect(taskScopeAllowsWorkspace(scoped, 'ws-1')).toBe(true);
    expect(taskScopeAllowsWorkspace(scoped, 'ws-2')).toBe(false);
    expect(taskScopeAllowsWorkspace(scoped, null)).toBe(false);
    expect(taskScopeAllowsWorkspace({}, 'anything')).toBe(true);
  });

  it('confines a scoped caller to its own task and worker', () => {
    expect(taskScopeAllowsTask(scoped, 'task-1')).toBe(true);
    expect(taskScopeAllowsTask(scoped, 'task-2')).toBe(false);
    expect(taskScopeAllowsTask(scoped, null)).toBe(false);
    expect(taskScopeAllowsWorker(scoped, { taskId: 'task-1' })).toBe(true);
    expect(taskScopeAllowsWorker(scoped, { taskId: 'task-2' })).toBe(false);
  });

  it('does not restrict an account key', () => {
    expect(taskScopeAllowsTask({}, 'anything')).toBe(true);
    expect(taskScopeAllowsWorker({}, { taskId: null })).toBe(true);
  });
});
