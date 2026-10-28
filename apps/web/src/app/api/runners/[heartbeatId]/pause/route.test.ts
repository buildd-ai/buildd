import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => Promise.resolve(null as any));
const mockGetUserTeamRole = mock(() => Promise.resolve(null as any));
const mockHbFindFirst = mock(() => Promise.resolve(null as any));
let updates: any[] = [];
const mockTrigger = mock(async (_c: string, _e: string, _d: unknown) => {});
const mockForget = mock(async (_id: string) => {});

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamRole: mockGetUserTeamRole }));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTrigger,
  channels: { runner: (id: string) => `runner-${id}` },
  events: { RUNNER_SLOTS: 'runner:slots' },
}));
mock.module('@/lib/runner-beats', () => ({
  forgetRunnerBeatState: mockForget,
  runnerBeatId: (a: string, u: string) => `${a}|${u}`,
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { workerHeartbeats: { findFirst: mockHbFindFirst } },
    update: () => ({ set: (v: any) => ({ where: () => { updates.push(v); return Promise.resolve(); } }) }),
  },
}));
mock.module('@buildd/core/db/schema', () => ({ workerHeartbeats: { id: 'id' } }));
mock.module('drizzle-orm', () => ({ eq: (a: any, b: any) => ({ a, b }) }));

import { PATCH } from './route';

const HB_ID = '11111111-1111-4111-8111-111111111111';
const call = (body: unknown, id = HB_ID) => PATCH(
  new NextRequest(`http://localhost:3000/api/runners/${id}/pause`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ heartbeatId: id }) },
);

describe('PATCH /api/runners/[heartbeatId]/pause', () => {
  beforeEach(() => {
    updates = [];
    mockTrigger.mockClear();
    mockForget.mockClear();
    mockGetCurrentUser.mockResolvedValue({ id: 'u1', name: 'Max', email: 'max@example.com' });
    mockHbFindFirst.mockResolvedValue({ id: HB_ID, accountId: 'acc-1', localUiUrl: 'http://r:1', account: { teamId: 't1' } });
    mockGetUserTeamRole.mockResolvedValue('admin');
  });

  it('401 without a session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await call({ paused: true })).status).toBe(401);
  });

  it('owner and admin pause with who and when, and the runner is nudged the way a slot change is', async () => {
    for (const role of ['owner', 'admin']) {
      updates = [];
      mockGetUserTeamRole.mockResolvedValue(role);
      const res = await call({ paused: true });
      expect(res.status).toBe(200);
      expect(updates[0]).toMatchObject({ desiredPaused: true, desiredPauseOrigin: 'dashboard', desiredPauseSetBy: 'Max' });
      expect(updates[0].desiredPauseSetAt).toBeInstanceOf(Date);
      const body = await res.json();
      expect(body.desiredPause).toMatchObject({ paused: true, origin: 'dashboard', setBy: 'Max' });
    }
    expect(mockForget).toHaveBeenCalledWith('acc-1|http://r:1');
    expect(mockTrigger.mock.calls[0].slice(0, 2)).toEqual(['runner-acc-1', 'runner:slots']);
  });

  it('Resume saves paused false and leaves the slots alone', async () => {
    const res = await call({ paused: false });
    expect(res.status).toBe(200);
    expect(updates[0]).toMatchObject({ desiredPaused: false, desiredPauseOrigin: 'dashboard' });
    // Pause is its own state: Resume brings back the slots the runner had.
    expect(Object.keys(updates[0]).some(k => k.startsWith('desiredSlots'))).toBe(false);
  });

  it('a plain member gets 403 and nothing is written', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    expect((await call({ paused: true })).status).toBe(403);
    expect(updates).toHaveLength(0);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('a runner of another team, an unknown runner and a non-UUID are 404', async () => {
    mockGetUserTeamRole.mockResolvedValue(null);
    expect((await call({ paused: true })).status).toBe(404);
    mockHbFindFirst.mockResolvedValue(null);
    expect((await call({ paused: true })).status).toBe(404);
    expect((await call({ paused: true }, 'nope')).status).toBe(404);
    expect(updates).toHaveLength(0);
  });

  it('refuses anything but true or false with 400', async () => {
    for (const paused of ['true', 1, 0, null, undefined]) {
      expect((await call({ paused })).status).toBe(400);
    }
    expect(updates).toHaveLength(0);
  });
});
