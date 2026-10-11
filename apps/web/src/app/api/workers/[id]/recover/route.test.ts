import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
// workers.id is a uuid column; the route 404s a non-UUID id before any lookup.
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockWorkersFindFirst = mock(() => null as any);
const mockTriggerEvent = mock(() => Promise.resolve());

const mockUpdateReturning = mock(() => [{ id: WORKER_ID }] as any[]);
const mockUpdateWhere = mock(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));
const mockUpdate = mock(() => ({ set: mockUpdateSet }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess }));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { worker: (id: string) => `worker-${id}` },
  events: { WORKER_COMMAND: 'worker:command' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: { workers: { findFirst: mockWorkersFindFirst } },
    update: () => mockUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'workers.id', status: 'workers.status' },
}));

import { POST } from './route';

const mockParams = Promise.resolve({ id: WORKER_ID });

function createRequest(body?: any, apiKey?: string): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest('http://localhost:3000/api/workers/worker-1/recover', {
    method: 'POST',
    headers: new Headers(headers),
    body: JSON.stringify(body ?? {}),
  });
}

const baseWorker = {
  id: WORKER_ID,
  taskId: 'task-1',
  workspaceId: 'workspace-1',
  accountId: 'account-1',
  status: 'failed',
  error: 'Agent crashed: tsc exited 2',
  workspace: { teamId: 'team-1' },
};

describe('POST /api/workers/[id]/recover', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockWorkersFindFirst.mockReset();
    mockTriggerEvent.mockClear();
    mockUpdate.mockClear();
    mockUpdateSet.mockClear();
    mockUpdateWhere.mockClear();
    mockUpdateReturning.mockClear();

    mockUpdateReturning.mockReturnValue([{ id: WORKER_ID }]);
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });
  });

  afterEach(() => {
    delete process.env.BUILDD_RECOVER_GUARD_TERMINATED;
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const res = await POST(createRequest({ mode: 'diagnose' }), { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 404 when worker not found', async () => {
    mockWorkersFindFirst.mockResolvedValue(null);
    const res = await POST(createRequest({ mode: 'diagnose' }), { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid mode', async () => {
    const res = await POST(createRequest({ mode: 'nope' }), { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('recovers a failed worker and sends the runner command', async () => {
    const res = await POST(createRequest({ mode: 'restart' }), { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(mockUpdateSet.mock.calls[0][0].status).toBe('running');
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
    expect(mockTriggerEvent.mock.calls[0][2].recoveryMode).toBe('restart');
  });

  // C31 regression: the update was `.where(eq(workers.id, id))` — by id alone.
  // A worker that finished (or was terminated) between the read and the write
  // was flipped to `running` anyway, leaving a row nothing re-syncs.
  it('writes under a status CAS so a concurrent change is not clobbered', async () => {
    await POST(createRequest({ mode: 'diagnose' }), { params: mockParams });

    const where = mockUpdateWhere.mock.calls[0][0] as any;
    const serialized = JSON.stringify(where);
    expect(serialized).toContain('workers.status');
    expect(serialized).toContain('failed');
  });

  it('returns 409 and sends no command when the CAS loses the race', async () => {
    mockUpdateReturning.mockReturnValue([]);

    const res = await POST(createRequest({ mode: 'diagnose' }), { params: mockParams });

    expect(res.status).toBe(409);
    // Never signal the runner for a row we did not win.
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  // C31 regression: no status check at all — a cleanly completed worker
  // (error: null, task done) could be flipped back to `running`, destroying the
  // completion the PATCH route works hard to protect.
  it('refuses to resurrect a cleanly completed worker', async () => {
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      status: 'completed',
      error: null,
    });

    const res = await POST(createRequest({ mode: 'restart' }), { params: mockParams });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain('completed');
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  describe('non-reactivatable terminations (gated)', () => {
    const expiredWorker = {
      ...baseWorker,
      status: 'failed',
      error: 'Worker expired — runner went offline',
    };

    it('still accepts them by default (today behaviour)', async () => {
      mockWorkersFindFirst.mockResolvedValue({ ...expiredWorker });

      const res = await POST(createRequest({ mode: 'diagnose' }), { params: mockParams });
      expect(res.status).toBe(200);
    });

    it('refuses them when BUILDD_RECOVER_GUARD_TERMINATED=true', async () => {
      process.env.BUILDD_RECOVER_GUARD_TERMINATED = 'true';
      mockWorkersFindFirst.mockResolvedValue({ ...expiredWorker });

      const res = await POST(createRequest({ mode: 'diagnose' }), { params: mockParams });

      expect(res.status).toBe(409);
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockTriggerEvent).not.toHaveBeenCalled();
    });

    it('refuses a reassigned worker when the guard is on', async () => {
      process.env.BUILDD_RECOVER_GUARD_TERMINATED = 'true';
      mockWorkersFindFirst.mockResolvedValue({
        ...baseWorker,
        status: 'failed',
        error: 'Task was reassigned',
      });

      const res = await POST(createRequest({ mode: 'restart' }), { params: mockParams });
      expect(res.status).toBe(409);
    });
  });
});

describe('POST /api/workers/[id]/recover — OAuth session owner check', () => {
  // Invariant: a bearer caller may recover only a worker it claimed. An OAuth
  // session shares its account with the whole team, so ownership is the session
  // user recorded at claim (claimedByUserId), not the account. Recovering a
  // teammate's worker goes through the dashboard cookie path, which checks
  // workspace membership instead.
  const oauthWorker = { ...baseWorker, workspaceId: 'workspace-1', claimedByUserId: 'user-a' };
  const session = (sessionUserId: string, extra: Record<string, unknown> = {}) =>
    ({ id: 'account-1', teamId: 'team-1', sessionUserId, level: 'admin', ...extra });

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockWorkersFindFirst.mockReset();
    mockTriggerEvent.mockClear();
    mockUpdate.mockClear();
    mockUpdateSet.mockClear();
    mockUpdateWhere.mockClear();
    mockUpdateReturning.mockClear();

    mockUpdateReturning.mockReturnValue([{ id: WORKER_ID }]);
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });

    mockGetCurrentUser.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    mockWorkersFindFirst.mockResolvedValue({ ...oauthWorker });
  });

  it('the session user that claimed the worker is allowed', async () => {
    mockAuthenticateApiKey.mockResolvedValue(session('user-a'));
    const res = await POST(createRequest({ mode: 'diagnose' }, 'oauth-token'), { params: mockParams });
    expect(res.status).toBe(200);
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
  });

  it('another member of the same team on the same account is refused, and nothing is written', async () => {
    mockAuthenticateApiKey.mockResolvedValue(session('user-b'));
    // A dashboard cookie for the same person must not rescue the bearer path.
    mockGetCurrentUser.mockResolvedValue({ id: 'user-b' });
    const res = await POST(createRequest({ mode: 'diagnose' }, 'oauth-token'), { params: mockParams });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it("the dashboard cookie session still recovers a teammate's worker via workspace access", async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-b' });
    const res = await POST(createRequest({ mode: 'diagnose' }), { params: mockParams });
    expect(res.status).toBe(200);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-b', 'workspace-1');
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
  });

  it('a session with no team id is refused even when the user matches', async () => {
    mockAuthenticateApiKey.mockResolvedValue(session('user-a', { teamId: null }));
    const res = await POST(createRequest({ mode: 'diagnose' }, 'oauth-token'), { params: mockParams });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });
});
