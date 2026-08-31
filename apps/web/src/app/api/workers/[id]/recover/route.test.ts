import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockWorkersFindFirst = mock(() => null as any);
const mockTriggerEvent = mock(() => Promise.resolve());

const mockUpdateReturning = mock(() => [{ id: 'worker-1' }] as any[]);
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

const mockParams = Promise.resolve({ id: 'worker-1' });

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
  id: 'worker-1',
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

    mockUpdateReturning.mockReturnValue([{ id: 'worker-1' }]);
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
