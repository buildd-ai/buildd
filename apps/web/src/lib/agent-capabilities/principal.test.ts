import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockGetPermissions = mock(() => Promise.resolve([] as any[]));
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockWorkersFindMany = mock(() => Promise.resolve([] as any[]));
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));

mock.module('@/lib/account-workspace-cache', () => ({ getAccountWorkspacePermissions: mockGetPermissions }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findMany: mockWorkersFindMany, findFirst: mockWorkersFindFirst },
    },
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id' },
  workers: { id: 'id', taskId: 'task_id', status: 'status' },
}));
mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ __eq: { f, v } }),
  and: (...c: any[]) => ({ __and: c }),
  inArray: (f: any, v: any) => ({ __in: { f, v } }),
}));

import { dispatchTokenMatches, hasClaimAuthority, ownLiveWorkers } from './principal';
import { resolveDispatchPrincipal } from './dispatch-principal';
import { resolveWorkerPrincipal } from './worker-principal';

// ── fixtures (illustrative) ───────────────────────────────────────────────────

const ACCOUNT = { id: 'account-1', teamId: 'team-1', workspaceIds: null };
const DISPATCH = 'dispatch-token-value';
const OPEN_WS = { id: 'ws-1', teamId: 'team-1', accessMode: 'open' };

function taskRow(ws: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    workspace: {
      ...OPEN_WS,
      webhookConfig: { enabled: true, token: DISPATCH },
      githubRepoId: 'repo-row-1',
      githubRepo: null,
      ...ws,
    },
  };
}

const worker = (o: Record<string, unknown> = {}) => ({
  id: 'worker-1', taskId: 'task-1', workspaceId: 'ws-1', accountId: 'account-1', status: 'running', ...o,
});

beforeEach(() => {
  mockGetPermissions.mockReset();
  mockGetPermissions.mockResolvedValue([]);
  mockTasksFindFirst.mockReset();
  mockTasksFindFirst.mockResolvedValue(taskRow());
  mockWorkersFindMany.mockReset();
  mockWorkersFindMany.mockResolvedValue([worker()]);
  mockWorkersFindFirst.mockReset();
  mockWorkersFindFirst.mockResolvedValue({ ...worker(), workspace: { ...OPEN_WS, githubRepoId: null, githubRepo: null } });
});

// ── claim authority ───────────────────────────────────────────────────────────

describe('hasClaimAuthority', () => {
  it('allows an open workspace of the account’s own team without a grant lookup', async () => {
    expect(await hasClaimAuthority(ACCOUNT, OPEN_WS)).toBe(true);
    expect(mockGetPermissions).not.toHaveBeenCalled();
  });

  it('refuses another team’s open workspace without a canClaim grant', async () => {
    expect(await hasClaimAuthority(ACCOUNT, { ...OPEN_WS, teamId: 'team-2' })).toBe(false);
  });

  it('allows another team’s workspace through a canClaim grant, and only canClaim', async () => {
    const ws = { ...OPEN_WS, teamId: 'team-2' };
    mockGetPermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: false }]);
    expect(await hasClaimAuthority(ACCOUNT, ws)).toBe(false);
    mockGetPermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
    expect(await hasClaimAuthority(ACCOUNT, ws)).toBe(true);
  });

  it('refuses a restricted workspace of the own team without a grant', async () => {
    expect(await hasClaimAuthority(ACCOUNT, { ...OPEN_WS, accessMode: 'restricted' })).toBe(false);
  });

  it('confines a workspace-restricted key to its list, even on its own team', async () => {
    expect(await hasClaimAuthority({ ...ACCOUNT, workspaceIds: ['ws-other'] }, OPEN_WS)).toBe(false);
  });
});

describe('dispatchTokenMatches', () => {
  it('matches only an enabled, non-empty, equal token', () => {
    expect(dispatchTokenMatches({ enabled: true, token: DISPATCH }, DISPATCH)).toBe(true);
    expect(dispatchTokenMatches({ enabled: true, token: DISPATCH }, 'other')).toBe(false);
    expect(dispatchTokenMatches({ enabled: false, token: DISPATCH }, DISPATCH)).toBe(false);
    expect(dispatchTokenMatches({ enabled: true, token: '' }, '')).toBe(false);
    expect(dispatchTokenMatches(null, DISPATCH)).toBe(false);
  });
});

describe('ownLiveWorkers', () => {
  const want = { taskId: 'task-1', workspaceId: 'ws-1', accountId: 'account-1' };

  it('keeps a live worker on this task, workspace and account', () => {
    expect(ownLiveWorkers([worker()], want).map(w => w.id)).toEqual(['worker-1']);
  });

  it.each([
    ['another task', { taskId: 'task-2' }],
    ['another workspace', { workspaceId: 'ws-2' }],
    ['another account', { accountId: 'account-2' }],
    ['a terminal worker', { status: 'completed' }],
    ['a failed worker', { status: 'failed' }],
  ])('drops %s', (_label, o) => {
    expect(ownLiveWorkers([worker(o)], want)).toEqual([]);
  });

  it('narrows to the named worker', () => {
    const rows = [worker(), worker({ id: 'worker-2' })];
    expect(ownLiveWorkers(rows, { ...want, workerId: 'worker-2' }).map(w => w.id)).toEqual(['worker-2']);
    expect(ownLiveWorkers(rows, { ...want, workerId: 'worker-3' })).toEqual([]);
  });
});

// ── cloud: task + dispatch token ──────────────────────────────────────────────

describe('resolveDispatchPrincipal', () => {
  const input = { taskId: 'task-1', dispatchToken: DISPATCH };

  it('resolves the live worker as an agent_run principal', async () => {
    const r = await resolveDispatchPrincipal(ACCOUNT, input);
    expect(r.ok && r.principal).toEqual({
      kind: 'agent_run', via: 'dispatch', workerId: 'worker-1', taskId: 'task-1',
      workspaceId: 'ws-1', teamId: 'team-1', accountId: 'account-1',
    });
  });

  it('refuses a task whose workspace row does not match its workspaceId', async () => {
    mockTasksFindFirst.mockResolvedValue({ ...taskRow(), workspaceId: 'ws-2' });
    const r = await resolveDispatchPrincipal(ACCOUNT, input);
    expect(!r.ok && r.reasonCode).toBe('not_found');
  });

  it('answers another team’s task with the same 404 as a missing one', async () => {
    mockTasksFindFirst.mockResolvedValue(taskRow({ teamId: 'team-2' }));
    const other = await resolveDispatchPrincipal(ACCOUNT, input);
    mockTasksFindFirst.mockResolvedValue(null);
    const missing = await resolveDispatchPrincipal(ACCOUNT, input);
    expect(other).toEqual(missing);
  });

  it('refuses a dispatch token from another workspace before looking at workers', async () => {
    const r = await resolveDispatchPrincipal(ACCOUNT, { ...input, dispatchToken: 'other-workspace-token' });
    expect(!r.ok && r.status).toBe(403);
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
  });

  it('refuses when the only live worker is another task’s or another account’s', async () => {
    mockWorkersFindMany.mockResolvedValue([worker({ taskId: 'task-2' }), worker({ accountId: 'account-2' })]);
    const r = await resolveDispatchPrincipal(ACCOUNT, input);
    expect(!r.ok && r.reasonCode).toBe('no_live_worker');
  });

  it('refuses a dead run', async () => {
    mockWorkersFindMany.mockResolvedValue([worker({ status: 'completed' })]);
    const r = await resolveDispatchPrincipal(ACCOUNT, input);
    expect(!r.ok && r.status).toBe(409);
  });

  it('refuses a workerId that is not this task’s live worker', async () => {
    const r = await resolveDispatchPrincipal(ACCOUNT, { ...input, workerId: 'worker-9' });
    expect(!r.ok && r.reasonCode).toBe('no_live_worker');
  });
});

// ── self-hosted: worker id ────────────────────────────────────────────────────

describe('resolveWorkerPrincipal', () => {
  it('resolves the named worker as an agent_run principal', async () => {
    const r = await resolveWorkerPrincipal(ACCOUNT, { workerId: 'worker-1' });
    expect(r.ok && r.principal).toEqual({
      kind: 'agent_run', via: 'runner_key', workerId: 'worker-1', taskId: 'task-1',
      workspaceId: 'ws-1', teamId: 'team-1', accountId: 'account-1',
    });
  });

  it('answers another account’s worker with the same 404 as a missing one', async () => {
    mockWorkersFindFirst.mockResolvedValue({ ...worker({ accountId: 'account-2' }), workspace: OPEN_WS });
    const other = await resolveWorkerPrincipal(ACCOUNT, { workerId: 'worker-1' });
    mockWorkersFindFirst.mockResolvedValue(null);
    const missing = await resolveWorkerPrincipal(ACCOUNT, { workerId: 'worker-1' });
    expect(other).toEqual(missing);
  });

  it('refuses after claim authority is revoked mid-run', async () => {
    mockWorkersFindFirst.mockResolvedValue({ ...worker(), workspace: { ...OPEN_WS, teamId: 'team-2' } });
    const r = await resolveWorkerPrincipal(ACCOUNT, { workerId: 'worker-1' });
    expect(!r.ok && r.status).toBe(404);
  });

  it.each([
    ['a terminal worker', { status: 'completed' }],
    ['a worker with no task', { taskId: null }],
  ])('refuses %s as not live', async (_label, o) => {
    mockWorkersFindFirst.mockResolvedValue({ ...worker(o), workspace: OPEN_WS });
    const r = await resolveWorkerPrincipal(ACCOUNT, { workerId: 'worker-1' });
    expect(!r.ok && r.reasonCode).toBe('worker_not_live');
  });
});
