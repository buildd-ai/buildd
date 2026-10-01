import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/** POST /api/missions/[id]/surface-audit/advice: a suggestion only, never an error the sheet must render. */

const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let missionRow: any = null;
let workspaceRow: any = null;
let currentUser: any = { id: 'u-1' };
let apiAccountRow: any = null;
let tasks: any[] = [];
let gateResult: any = { required: true, source: 'diff', uiPaths: ['apps/web/src/components/Nav.tsx'] };
let cached: any = null;
let advised: any = { recommend: 'audit', why: 'These changes can change what people see.' };
let adviseThrows = false;

mock.module('drizzle-orm', () => ({ eq: (...a: any[]) => ({ _op: 'eq', a }) }));
mock.module('@buildd/core/db/schema', () => ({ missions: Symbol('missions'), workspaces: Symbol('workspaces') }));
mock.module('@buildd/core/db', () => ({
  db: { query: {
    missions: { findFirst: () => Promise.resolve(missionRow) },
    workspaces: { findFirst: () => Promise.resolve(workspaceRow) },
  } },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: () => Promise.resolve(apiAccountRow) }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: () => Promise.resolve(['team-1']) }));
mock.module('@/lib/open-workspaces', () => ({ workspaceOpenToCaller: () => Promise.resolve(false) }));
const gate = mock((..._a: any[]) => Promise.resolve(gateResult));
mock.module('@/lib/mission-surface-audit-gate', () => ({
  loadSurfaceAuditGateTasks: () => Promise.resolve(tasks),
  evaluateSurfaceAuditGate: gate,
}));
const advise = mock((input: any) => (adviseThrows ? Promise.reject(new Error('boom')) : Promise.resolve(advised)));
mock.module('@/lib/surface-audit-advice', () => ({
  adviseSurfaceAudit: advise,
  cachedSurfaceAuditAdvice: () => cached,
}));

const { POST } = await import('./route');
const call = (id = ID) => POST(new NextRequest(`http://localhost/api/missions/${id}/surface-audit/advice`, { method: 'POST' }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  missionRow = { id: ID, teamId: 'team-1', workspaceId: 'ws-1', autoSurfaceAudit: true };
  workspaceRow = { gitConfig: {} };
  currentUser = { id: 'u-1' };
  apiAccountRow = null;
  tasks = [
    { id: 'b1', title: 'Reword the sheet', status: 'completed', taskClass: 'work', workers: [{ prNumber: 12 }] },
    { id: 'b2', title: 'Add nav', status: 'completed', taskClass: 'work', workers: [{ prNumber: 7 }] },
    { id: 'a1', title: '[surface audit] x', status: 'failed', taskClass: 'work', workers: [] },
    { id: 'b3', title: 'Still open', status: 'pending', taskClass: 'work', workers: [{ prNumber: 99 }] },
  ];
  gateResult = { required: true, source: 'diff', uiPaths: ['apps/web/src/components/Nav.tsx'] };
  cached = null;
  advised = { recommend: 'audit', why: 'These changes can change what people see.' };
  adviseThrows = false;
  gate.mockClear();
  advise.mockClear();
});

describe('POST /api/missions/[id]/surface-audit/advice', () => {
  it('401s without a session or key, 404s a foreign mission', async () => {
    currentUser = null;
    expect((await call()).status).toBe(401);
    currentUser = { id: 'u-1' };
    missionRow = { ...missionRow, teamId: 'other' };
    expect((await call()).status).toBe(404);
    expect(advise).not.toHaveBeenCalled();
  });

  it('asks with the changed files, merged PRs and finished work titles only', async () => {
    const res = await call();
    expect((await res.json()).advice).toEqual(advised);
    const input = advise.mock.calls[0][0];
    expect(input.prNumbers.sort()).toEqual([12, 7]);
    expect(input.workTitles).toEqual(['Reword the sheet', 'Add nav']);
    expect(input.uiPaths).toEqual(['apps/web/src/components/Nav.tsx']);
    expect(input.teamId).toBe('team-1');
    expect(input.userId).toBe('u-1');
  });

  it('answers from the cache without reading diffs or spending', async () => {
    cached = { recommend: 'waive', why: 'cached', waiverDraft: 'Owner review: cached draft.' };
    expect((await (await call()).json()).advice).toEqual(cached);
    expect(gate).not.toHaveBeenCalled();
    expect(advise).not.toHaveBeenCalled();
  });

  it('has no suggestion when the mission no longer owes an audit', async () => {
    gateResult = { required: false, why: 'has_audit' };
    expect((await (await call()).json()).advice).toBeNull();
    expect(advise).not.toHaveBeenCalled();
  });

  it('passes a sensitive workspace through so nothing is sent out', async () => {
    workspaceRow = { gitConfig: { dataClass: 'sensitive' } };
    await call();
    expect(advise.mock.calls[0][0].dataClass).toBe('sensitive');
  });

  it('fails soft: an unexpected error is "no suggestion", status 200', async () => {
    adviseThrows = true;
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).advice).toBeNull();
  });
});
