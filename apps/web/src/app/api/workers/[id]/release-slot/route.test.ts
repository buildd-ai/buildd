import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WORKER_ID = '44444444-4444-4444-8444-444444444444';

let workerRow: Record<string, unknown> | null;
const mockGetCurrentUser = mock(async () => null as any);
const mockHolds = mock(async (_u: string, _ws: string, _p: string) => true);
const mockDetach = mock(async (_input: any) => ({ detached: true, workerStatus: 'completed', taskStatus: 'completed' } as any));

mock.module('@buildd/core/db', () => ({
  db: { query: { workers: { findFirst: async () => workerRow } } },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ holdsInWorkspace: mockHolds }));
mock.module('@/lib/interactive-detach', () => ({ detachInteractiveWorker: mockDetach }));

const { POST } = await import('./route');

function req(body: unknown = {}, contentType = 'application/json') {
  return new NextRequest(`http://localhost/api/workers/${WORKER_ID}/release-slot`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: JSON.stringify(body),
  });
}
const call = (r: NextRequest, id = WORKER_ID) => POST(r, { params: Promise.resolve({ id }) });

beforeEach(() => {
  workerRow = { id: WORKER_ID, workspaceId: 'ws-1', runner: 'mcp' };
  mockGetCurrentUser.mockReset();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1', name: 'Sam' });
  mockHolds.mockReset();
  mockHolds.mockResolvedValue(true);
  mockDetach.mockReset();
  mockDetach.mockResolvedValue({ detached: true, workerStatus: 'completed', taskStatus: 'completed' });
});

describe('POST /api/workers/[id]/release-slot', () => {
  it('requires a JSON request', async () => {
    expect((await call(req({}, 'text/plain'))).status).toBe(415);
  });

  it('requires a signed-in user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await call(req())).status).toBe(401);
    expect(mockDetach).not.toHaveBeenCalled();
  });

  it('404s an unknown or malformed worker id', async () => {
    expect((await call(req(), 'nope')).status).toBe(404);
    workerRow = null;
    expect((await call(req())).status).toBe(404);
  });

  it('is for team owners and admins only', async () => {
    mockHolds.mockResolvedValue(false);
    const res = await call(req());
    expect(res.status).toBe(403);
    expect(mockHolds).toHaveBeenCalledWith('user-1', 'ws-1', 'force_reassign_task');
    expect(mockDetach).not.toHaveBeenCalled();
  });

  it('refuses a runner-backed worker: Stop agent still owns those', async () => {
    workerRow = { id: WORKER_ID, workspaceId: 'ws-1', runner: 'runner-abc' };
    const res = await call(req());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Stop agent');
    expect(mockDetach).not.toHaveBeenCalled();
  });

  it('detaches a local session, recording who released it and why', async () => {
    const res = await call(req({ reason: 'task already ended' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, released: true, workerStatus: 'completed', taskStatus: 'completed' });
    expect(mockDetach).toHaveBeenCalledWith({
      workerId: WORKER_ID,
      actor: { kind: 'user', userId: 'user-1', label: 'Sam' },
      reason: 'task already ended',
    });
  });

  it('a repeat is a 200 no-op, not an error', async () => {
    mockDetach.mockResolvedValue({ detached: false, reason: 'already_released', taskStatus: 'completed' });
    const res = await call(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, released: false });
  });

  // Not an owner route: a team admin frees the slot of a session whoever
  // claimed it. It has no bearer path at all.
  describe("— role path acts on another member's session-claimed worker", () => {
    it('a dashboard admin releases a slot user-a claimed', async () => {
      workerRow = { id: WORKER_ID, workspaceId: 'ws-1', runner: 'mcp', accountId: 'account-1', claimedByUserId: 'user-a' };
      mockGetCurrentUser.mockResolvedValue({ id: 'user-b', name: 'Bo' });

      const res = await call(req());

      expect(res.status).toBe(200);
      expect(mockHolds).toHaveBeenCalledWith('user-b', 'ws-1', 'force_reassign_task');
      expect(mockDetach).toHaveBeenCalledTimes(1);
    });

    it('a bearer header without a cookie session is 401', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      const r = new NextRequest(`http://localhost/api/workers/${WORKER_ID}/release-slot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer bld_admin' },
        body: '{}',
      });

      expect((await call(r)).status).toBe(401);
      expect(mockHolds).not.toHaveBeenCalled();
      expect(mockDetach).not.toHaveBeenCalled();
    });
  });
});
