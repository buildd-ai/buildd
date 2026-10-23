import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/** POST /api/workspaces/[id]/lanes/release: a person releases a stuck lane's holder (spec: Overlap scheduling, I-7, AC-9). */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOLDER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let currentUser: any = { id: 'u-1' };
let apiAccountRow: any = null;
let access = true;
let releaseResult = true;
const mockRelease = mock((_i: any) => Promise.resolve(releaseResult));
const events: any[] = [];

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: () => Promise.resolve(apiAccountRow) }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: () => Promise.resolve(access),
  verifyAccountWorkspaceAccess: () => Promise.resolve(access),
}));
mock.module('@/lib/serial-lanes-store', () => ({ releaseLaneHolder: mockRelease }));
const { GATE_SLUGS } = await import('@buildd/core/gate-slugs');
mock.module('@/lib/gate-ledger', () => ({ GATE_SLUGS, fireGateEvent: (e: any) => { events.push(e); return 'sig'; } }));

const { POST } = await import('./route');
const call = (body: unknown, id = WS) => POST(
  new NextRequest(`http://localhost/api/workspaces/${id}/lanes/release`, { method: 'POST', body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  currentUser = { id: 'u-1' };
  apiAccountRow = null;
  access = true;
  releaseResult = true;
  mockRelease.mockClear();
  events.length = 0;
});

describe('POST /api/workspaces/[id]/lanes/release', () => {
  it('a signed-in person releases the holder, and it is recorded with who did it', async () => {
    const res = await call({ lane: 'migration', taskId: HOLDER, reason: 'PR abandoned' });
    expect(res.status).toBe(200);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockRelease.mock.calls[0][0]).toMatchObject({ workspaceId: WS, lane: 'migration', taskId: HOLDER, userId: 'u-1' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      gate: 'serial_lane', outcome: 'bypassed', reason: 'lane_released', workspaceId: WS, taskId: HOLDER,
      detail: { lane: 'migration', holderTaskId: HOLDER, userId: 'u-1', reason: 'PR abandoned' },
    });
  });

  it('401 without a session or key', async () => {
    currentUser = null;
    expect((await call({ lane: 'migration', taskId: HOLDER })).status).toBe(401);
  });

  it('refuses an API key or task token: only a person releases a lane', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct', taskScope: { taskId: 'x' } };
    expect((await call({ lane: 'migration', taskId: HOLDER })).status).toBe(403);
    apiAccountRow = { id: 'acct' };
    expect((await call({ lane: 'migration', taskId: HOLDER })).status).toBe(403);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('400 without a lane or a holder id; 404 without access or when the task is not in the lane', async () => {
    expect((await call({ lane: '', taskId: HOLDER })).status).toBe(400);
    expect((await call({ lane: 'migration', taskId: 'nope' })).status).toBe(400);
    access = false;
    expect((await call({ lane: 'migration', taskId: HOLDER })).status).toBe(404);
    access = true;
    releaseResult = false;
    expect((await call({ lane: 'migration', taskId: HOLDER })).status).toBe(404);
    expect(events).toHaveLength(0);
  });
});
