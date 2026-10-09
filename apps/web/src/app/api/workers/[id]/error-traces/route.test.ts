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

// Invariant: an OAuth session acts as an account its whole team shares, so a
// bearer caller reads a worker's traces only when its session user is the one
// that claimed it (lib/worker-owner.ts). A teammate's session, an admin-level
// session that did not claim, and a session with no team id are refused. The
// dashboard cookie path stays workspace-access based and is unaffected.
describe('GET /api/workers/[id]/error-traces — OAuth session owner check', () => {
  const session = (over: Record<string, unknown> = {}) => ({ id: 'acct-1', teamId: 'team-1', sessionUserId: 'user-a', level: 'worker', ...over });
  const claimed = (claimedByUserId: string) => ({ id: WORKER, accountId: 'acct-1', workspaceId: 'ws-1', claimedByUserId });

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockWorkerFindFirst.mockReset();
    mockTracesFindMany.mockReset();
    mockTracesFindMany.mockResolvedValue([{ pattern: 'git_fatal', excerpt: 'fatal' }]);
  });

  it('lets the session that claimed the worker read its traces', async () => {
    mockAuthenticateApiKey.mockResolvedValue(session());
    mockWorkerFindFirst.mockResolvedValue(claimed('user-a'));
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    expect(mockTracesFindMany).toHaveBeenCalledTimes(1);
  });

  it('403s a same-team member on the shared account, without reading traces', async () => {
    mockAuthenticateApiKey.mockResolvedValue(session({ sessionUserId: 'user-b' }));
    mockWorkerFindFirst.mockResolvedValue(claimed('user-a'));
    const res = await GET(req(), params());
    expect(res.status).toBe(403);
    expect(mockTracesFindMany).not.toHaveBeenCalled();
  });

  it('403s an admin-level bearer session that did not claim the worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue(session({ sessionUserId: 'user-b', level: 'admin' }));
    mockWorkerFindFirst.mockResolvedValue(claimed('user-a'));
    const res = await GET(req(), params());
    expect(res.status).toBe(403);
    expect(mockTracesFindMany).not.toHaveBeenCalled();
  });

  it('still lets a dashboard cookie session with workspace access read a teammate’s worker', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-b' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    mockWorkerFindFirst.mockResolvedValue(claimed('user-a'));
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-b', 'ws-1');
  });

  it('403s a session with no team id, even as the claimer', async () => {
    mockAuthenticateApiKey.mockResolvedValue(session({ teamId: null }));
    mockWorkerFindFirst.mockResolvedValue(claimed('user-a'));
    const res = await GET(req(), params());
    expect(res.status).toBe(403);
    expect(mockTracesFindMany).not.toHaveBeenCalled();
  });
});
