import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess }));

const mockWorkerFindFirst = mock(() => Promise.resolve(null as any));
const mockTracesFindMany = mock((_args: any) => Promise.resolve([] as any[]));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkerFindFirst },
      workerErrorTraces: { findMany: mockTracesFindMany },
    },
  },
}));

import { GET } from './route';

const WORKER = 'abcdef12-3456-4789-8abc-def012345678';

function req() {
  return new NextRequest(`http://localhost:3000/api/workers/${WORKER}/error-traces`, {
    headers: new Headers({ authorization: 'Bearer bld_x' }),
  });
}
const params = () => ({ params: Promise.resolve({ id: WORKER }) });

describe('GET /api/workers/[id]/error-traces', () => {
  const scoped = { id: 'acct-1', level: 'worker', taskScope: { taskId: 'task-own', workspaceId: 'ws-mine', expiresAt: Date.now() + 60_000 } };

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockReset();
    mockWorkerFindFirst.mockReset();
    mockTracesFindMany.mockReset();
    mockTracesFindMany.mockResolvedValue([{ pattern: 'git_fatal', excerpt: 'fatal' }]);
  });

  it('401s with no caller', async () => {
    const res = await GET(req(), params());
    expect(res.status).toBe(401);
  });

  it('lets an account key read its own worker in any workspace', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1' });
    mockWorkerFindFirst.mockResolvedValue({ id: WORKER, accountId: 'acct-1', workspaceId: 'ws-other' });
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(1);
  });

  it('403s an account key on another account’s worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1' });
    mockWorkerFindFirst.mockResolvedValue({ id: WORKER, accountId: 'acct-2', workspaceId: 'ws-mine' });
    const res = await GET(req(), params());
    expect(res.status).toBe(403);
  });

  describe('per-task token', () => {
    beforeEach(() => {
      mockAuthenticateApiKey.mockResolvedValue(scoped);
    });

    it('reads a worker of its account in its own workspace, not only its own task’s', async () => {
      mockWorkerFindFirst.mockResolvedValue({ id: WORKER, accountId: 'acct-1', workspaceId: 'ws-mine' });
      const res = await GET(req(), params());
      expect(res.status).toBe(200);
    });

    it('404s on its account’s worker in another workspace, without reading traces', async () => {
      mockWorkerFindFirst.mockResolvedValue({ id: WORKER, accountId: 'acct-1', workspaceId: 'ws-other' });
      const res = await GET(req(), params());
      expect(res.status).toBe(404);
      expect(mockTracesFindMany).not.toHaveBeenCalled();
    });

    it('is never wider than its account: another account’s worker stays refused', async () => {
      mockWorkerFindFirst.mockResolvedValue({ id: WORKER, accountId: 'acct-2', workspaceId: 'ws-mine' });
      const res = await GET(req(), params());
      expect(res.status).toBe(403);
    });
  });
});
