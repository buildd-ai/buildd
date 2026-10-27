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
  new NextRequest(`http://localhost:3000/api/runners/${id}/slots`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ heartbeatId: id }) },
);

describe('PATCH /api/runners/[heartbeatId]/slots', () => {
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
    expect((await call({ slots: 8 })).status).toBe(401);
  });

  it('owner and admin save the value with who and when, and nudge the runner', async () => {
    for (const role of ['owner', 'admin']) {
      updates = [];
      mockGetUserTeamRole.mockResolvedValue(role);
      const res = await call({ slots: 12 });
      expect(res.status).toBe(200);
      expect(updates[0]).toMatchObject({ desiredSlots: 12, desiredSlotsOrigin: 'dashboard', desiredSlotsSetBy: 'Max' });
      expect(updates[0].desiredSlotsSetAt).toBeInstanceOf(Date);
    }
    expect(mockForget).toHaveBeenCalledWith('acc-1|http://r:1');
    expect(mockTrigger.mock.calls[0].slice(0, 2)).toEqual(['runner-acc-1', 'runner:slots']);
  });

  it('a plain member gets 403 and nothing is written', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    expect((await call({ slots: 12 })).status).toBe(403);
    expect(updates).toHaveLength(0);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('a runner of another team is 404', async () => {
    mockGetUserTeamRole.mockResolvedValue(null);
    expect((await call({ slots: 12 })).status).toBe(404);
    expect(updates).toHaveLength(0);
  });

  it('an unknown runner and a non-UUID are 404', async () => {
    mockHbFindFirst.mockResolvedValue(null);
    expect((await call({ slots: 12 })).status).toBe(404);
    expect((await call({ slots: 12 }, 'nope')).status).toBe(404);
  });

  it('refuses a value outside 0 to 50 or not a whole number with 400', async () => {
    for (const slots of [51, -1, 2.5, '8', null, undefined]) {
      expect((await call({ slots })).status).toBe(400);
    }
    expect((await call({ slots: 1 })).status).toBe(200);
    expect((await call({ slots: 50 })).status).toBe(200);
  });

  it('accepts 0: the runner claims nothing (spec 97b1bd0b R-18)', async () => {
    const res = await call({ slots: 0 });
    expect(res.status).toBe(200);
    expect(updates[0]).toMatchObject({ desiredSlots: 0, desiredSlotsOrigin: 'dashboard' });
    expect((await res.json()).desiredSlots.slots).toBe(0);
  });
});
