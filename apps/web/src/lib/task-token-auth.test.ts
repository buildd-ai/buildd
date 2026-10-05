import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

const mockAuthenticateApiKey = mock((_key: string | null) => Promise.resolve(null as any));
const mockAccountsFindFirst = mock(() => Promise.resolve(null as any));
const mockTasksFindFirst = mock((_args: any) => Promise.resolve(null as any));
const mockWorkersFindFirst = mock((_args: any) => Promise.resolve(null as any));

mock.module('./api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@buildd/core/db', () => ({
  db: { query: { accounts: { findFirst: mockAccountsFindFirst }, tasks: { findFirst: mockTasksFindFirst }, workers: { findFirst: mockWorkersFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({ accounts: { id: 'id' } }));
mock.module('drizzle-orm', () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));

import {
  authenticateTaskScopedCaller, taskScopeAllowsInitiative, taskScopeAllowsMission, taskScopeAllowsTask,
  taskScopeAllowsWorker, taskScopeAllowsWorkerId, taskScopeAllowsWorkerPr, taskScopeAllowsWorkspace,
} from './task-token-auth';
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

  it('a task token minted by a scoped key works only while that key still holds the runner capabilities', async () => {
    const { token } = mintTaskToken(MINT)!;
    const RUNNER = ['tasks:read', 'tasks:write', 'workers:write', 'analytics:read', 'knowledge:write'];
    // The runner preset, or admin: the token is worker-level and confined to its task.
    mockAccountsFindFirst.mockResolvedValue({ ...ACCOUNT, scopes: RUNNER, workspaceIds: null });
    expect((await authenticateTaskScopedCaller(token))?.taskScope?.taskId).toBe('task-1');
    mockAccountsFindFirst.mockResolvedValue({ ...ACCOUNT, scopes: ['admin'], workspaceIds: null });
    expect(await authenticateTaskScopedCaller(token)).not.toBeNull();
    // Narrowed below the preset after minting: refused, so the token never outranks its key.
    mockAccountsFindFirst.mockResolvedValue({ ...ACCOUNT, scopes: ['tasks:read', 'workers:write'], workspaceIds: null });
    expect(await authenticateTaskScopedCaller(token)).toBeNull();
  });

  it("a scoped key's workspace list still applies to the tokens it minted", async () => {
    const { token } = mintTaskToken(MINT)!;
    const RUNNER = ['tasks:read', 'tasks:write', 'workers:write', 'analytics:read', 'knowledge:write'];
    mockAccountsFindFirst.mockResolvedValue({ ...ACCOUNT, scopes: RUNNER, workspaceIds: ['ws-1'] });
    expect(await authenticateTaskScopedCaller(token)).not.toBeNull();
    mockAccountsFindFirst.mockResolvedValue({ ...ACCOUNT, scopes: RUNNER, workspaceIds: ['ws-other'] });
    expect(await authenticateTaskScopedCaller(token)).toBeNull();
  });

  it('a task token whose minting account has expired is refused; a legacy key resolves with no scopes', async () => {
    const { token } = mintTaskToken(MINT)!;
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

describe('taskScopeAllowsWorkerPr', () => {
  const scoped = { id: 'acct-1', taskScope: { taskId: 'task-1', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };
  const own = { taskId: 'task-1', accountId: 'acct-1', prNumber: 42 };

  it('allows any caller that is not a task token', () => {
    expect(taskScopeAllowsWorkerPr({ id: 'acct-1' }, { taskId: 'task-9', prNumber: 1 }, 7)).toBe(true);
  });
  it('allows its own task’s PR', () => {
    expect(taskScopeAllowsWorkerPr(scoped, own, 42)).toBe(true);
  });
  it('refuses another PR number on its own worker', () => {
    expect(taskScopeAllowsWorkerPr(scoped, own, 7)).toBe(false);
  });
  it('refuses another task’s worker', () => {
    expect(taskScopeAllowsWorkerPr(scoped, { ...own, taskId: 'task-2' }, 42)).toBe(false);
  });
  it('refuses a worker claimed by another account', () => {
    expect(taskScopeAllowsWorkerPr(scoped, { ...own, accountId: 'acct-2' }, 42)).toBe(false);
  });
  it('refuses a worker with no PR recorded', () => {
    expect(taskScopeAllowsWorkerPr(scoped, { ...own, prNumber: null }, 42)).toBe(false);
  });
});

describe('taskScopeAllowsMission / taskScopeAllowsInitiative', () => {
  const scoped = { id: 'acct-1', taskScope: { taskId: 'task-1', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };
  beforeEach(() => {
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue({ missionId: 'm-1', workspaceId: 'ws-1', mission: { initiativeId: 'i-1' } });
  });

  it('does not restrict an account key, and reads nothing for it', async () => {
    expect(await taskScopeAllowsMission({}, 'm-9')).toBe(true);
    expect(await taskScopeAllowsInitiative({}, 'i-9')).toBe(true);
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
  });
  it("allows its own task's mission and that mission's initiative", async () => {
    expect(await taskScopeAllowsMission(scoped, 'm-1')).toBe(true);
    expect(await taskScopeAllowsInitiative(scoped, 'i-1')).toBe(true);
  });
  it('refuses another mission or initiative, and a missing id', async () => {
    expect(await taskScopeAllowsMission(scoped, 'm-2')).toBe(false);
    expect(await taskScopeAllowsInitiative(scoped, 'i-2')).toBe(false);
    expect(await taskScopeAllowsMission(scoped, null)).toBe(false);
  });
  it('refuses everything when its task has no mission', async () => {
    mockTasksFindFirst.mockResolvedValue({ missionId: null, workspaceId: 'ws-1', mission: null });
    expect(await taskScopeAllowsMission(scoped, 'm-1')).toBe(false);
    expect(await taskScopeAllowsInitiative(scoped, 'i-1')).toBe(false);
  });
  it('refuses when its task is no longer in the token workspace', async () => {
    mockTasksFindFirst.mockResolvedValue({ missionId: 'm-1', workspaceId: 'ws-2', mission: { initiativeId: 'i-1' } });
    expect(await taskScopeAllowsMission(scoped, 'm-1')).toBe(false);
  });
});

describe('taskScopeAllowsWorkerId', () => {
  const scoped = { id: 'acct-1', taskScope: { taskId: 'task-1', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };
  beforeEach(() => mockWorkersFindFirst.mockReset());

  it('allows an account key and an absent id without a read', async () => {
    expect(await taskScopeAllowsWorkerId({ id: 'acct-1' }, 'w-9')).toBe(true);
    expect(await taskScopeAllowsWorkerId(scoped, undefined)).toBe(true);
    expect(mockWorkersFindFirst).not.toHaveBeenCalled();
  });
  it('allows its own worker only', async () => {
    mockWorkersFindFirst.mockResolvedValue({ taskId: 'task-1', accountId: 'acct-1' });
    expect(await taskScopeAllowsWorkerId(scoped, 'w-1')).toBe(true);
    mockWorkersFindFirst.mockResolvedValue({ taskId: 'task-2', accountId: 'acct-1' });
    expect(await taskScopeAllowsWorkerId(scoped, 'w-2')).toBe(false);
    mockWorkersFindFirst.mockResolvedValue({ taskId: 'task-1', accountId: 'acct-2' });
    expect(await taskScopeAllowsWorkerId(scoped, 'w-3')).toBe(false);
    mockWorkersFindFirst.mockResolvedValue(null);
    expect(await taskScopeAllowsWorkerId(scoped, 'w-gone')).toBe(false);
  });
});
