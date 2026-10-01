import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/** POST /api/missions/[id]/surface-audit: the decision sheet's "Run visual audit". */

const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let missionRow: any = null;
let currentUser: any = { id: 'u-1' };
let apiAccountRow: any = null;
let openToCaller = false;
let result: any = { ok: true, created: true, taskId: 't-1', status: 'pending' };

mock.module('drizzle-orm', () => ({ eq: (...a: any[]) => ({ _op: 'eq', a }) }));
mock.module('@buildd/core/db/schema', () => ({ missions: Symbol('missions') }));
mock.module('@buildd/core/db', () => ({
  db: { query: { missions: { findFirst: () => Promise.resolve(missionRow) } } },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: () => Promise.resolve(apiAccountRow) }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: () => Promise.resolve(['team-1']) }));
mock.module('@/lib/open-workspaces', () => ({ workspaceOpenToCaller: () => Promise.resolve(openToCaller) }));
const request = mock((_id: string) => Promise.resolve(result));
mock.module('@/lib/mission-surface-audit', () => ({ requestMissionSurfaceAudit: request }));

const { POST } = await import('./route');
const call = (id = ID) => POST(new NextRequest(`http://localhost/api/missions/${id}/surface-audit`, { method: 'POST' }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  missionRow = { id: ID, teamId: 'team-1', workspaceId: 'ws-1' };
  currentUser = { id: 'u-1' };
  apiAccountRow = null;
  openToCaller = false;
  result = { ok: true, created: true, taskId: 't-1', status: 'pending' };
  request.mockClear();
});

describe('POST /api/missions/[id]/surface-audit', () => {
  it('401s without a session or key', async () => {
    currentUser = null;
    expect((await call()).status).toBe(401);
    expect(request).not.toHaveBeenCalled();
  });

  it('404s a non-UUID id', async () => {
    expect((await call('a1b2c3d4')).status).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });

  it('403s a non-admin API key', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-1', level: 'worker' };
    expect((await call()).status).toBe(403);
  });

  it('404s a mission outside the caller\'s teams', async () => {
    missionRow = { ...missionRow, teamId: 'other' };
    expect((await call()).status).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });

  it('files the audit and reports it', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: true, taskId: 't-1', status: 'pending' });
    expect(request).toHaveBeenCalledWith(ID);
  });

  it('reports an audit that already exists as not created', async () => {
    result = { ok: true, created: false, taskId: 't-0', status: 'running' };
    expect((await (await call()).json()).created).toBe(false);
  });

  it('409s a closed mission with words a person can read', async () => {
    result = { ok: false, reason: 'mission_closed' };
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('already closed');
  });
});
