import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockGetCurrentUser = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockRequestWorkerPause = mock(async () => true);

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess }));
mock.module('@buildd/core/db', () => ({ db: { query: { workers: { findFirst: mockWorkersFindFirst } } } }));
mock.module('drizzle-orm', () => ({ eq: (field: any, value: any) => ({ field, value, type: 'eq' }) }));
mock.module('@buildd/core/db/schema', () => ({ workers: 'workers' }));
mock.module('@/lib/worker-owner', () => ({ callerOwnsWorker: (a: any, w: any) => a.id === w.accountId }));
mock.module('@/lib/worker-pause', () => ({
  ...require('@/lib/worker-pause-policy'),
  requestWorkerPause: mockRequestWorkerPause,
}));

const { POST } = await import('./route');

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const params = Promise.resolve({ id: WORKER_ID });
const req = (headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  new NextRequest(`http://localhost:3000/api/workers/${WORKER_ID}/pause`, { method: 'POST', headers: new Headers(headers), body: '{}' });
const running = { id: WORKER_ID, workspaceId: 'ws-1', status: 'running', runner: 'coder', accountId: 'acc-1', waitingFor: null };

describe('POST /api/workers/[id]/pause', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockWorkersFindFirst.mockReset();
    mockRequestWorkerPause.mockReset();
    mockRequestWorkerPause.mockResolvedValue(true);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue(running);
  });

  it('records the pause for a running agent of a member', async () => {
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).requested).toBe(true);
    expect(mockRequestWorkerPause).toHaveBeenCalledWith(WORKER_ID);
  });

  it('401 without a session or key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await POST(req(), { params })).status).toBe(401);
  });

  it('404 for a non-member', async () => {
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    expect((await POST(req(), { params })).status).toBe(404);
    expect(mockRequestWorkerPause).not.toHaveBeenCalled();
  });

  it('415 for a form post', async () => {
    expect((await POST(req({}), { params })).status).toBe(415);
  });

  it('409 for a worker that is not running', async () => {
    mockWorkersFindFirst.mockResolvedValue({ ...running, status: 'completed' });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not_running');
    expect(mockRequestWorkerPause).not.toHaveBeenCalled();
  });

  it('409 when already paused', async () => {
    mockWorkersFindFirst.mockResolvedValue({ ...running, status: 'waiting_input', waitingFor: { type: 'pause' } });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('already_paused');
  });

  it('400 for a local session buildd cannot reach', async () => {
    mockWorkersFindFirst.mockResolvedValue({ ...running, runner: 'mcp' });
    const res = await POST(req(), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('interactive');
  });

  it('an API key must be the one that claimed the worker', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-2' });
    expect((await POST(req({ 'content-type': 'application/json', authorization: 'Bearer bld_x' }), { params })).status).toBe(403);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1' });
    expect((await POST(req({ 'content-type': 'application/json', authorization: 'Bearer bld_x' }), { params })).status).toBe(200);
  });

  it('409 when the worker stopped running before the request landed', async () => {
    mockRequestWorkerPause.mockResolvedValue(false);
    expect((await POST(req(), { params })).status).toBe(409);
  });
});
