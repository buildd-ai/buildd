import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-a';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

type Role = 'member' | 'admin' | 'owner';
let viewer: any;

const mockResolveViewer = mock(async () => viewer);
const mockGet = mock(async (_teamId: string, _id: string) => null as any);
const mockFindOtherRunning = mock(async (..._a: any[]) => null as any);
const mockApply = mock(async (..._a: any[]) => null as any);

// A real per-task token, verified by the real authenticateTaskScopedCaller.
process.env.AUTH_SECRET ||= 'test-task-token-secret';
const { mintTaskToken } = await import('@/lib/task-token');
const KEY_HASH = 'key-hash';
const taskToken = () =>
  mintTaskToken({ accountId: 'acct-1', taskId: 'task-own', workspaceId: 'ws-own', keyHash: KEY_HASH })!.token;
const mockAccountFind = mock(async () => ({ id: 'acct-1', apiKey: KEY_HASH, teamId: TEAM, level: 'admin', scopes: null, workspaceIds: null, expiresAt: null }));
mock.module('@buildd/core/db', () => ({ db: { query: { teams: { findFirst: async () => null }, accounts: { findFirst: mockAccountFind } } } }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mock(async () => null as any) }));
const mockTaskViewer = mock(async (_workspaceId: string, accountId: string) =>
  ({ ok: true, viewer: { teamId: TEAM, role: 'member', userId: null, accountId } }) as any);

mock.module('@/lib/experiment-access', () => ({
  resolveExperimentViewer: mockResolveViewer,
  taskTokenExperimentViewer: mockTaskViewer,
  bearerOf: (req: NextRequest) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null,
}));
mock.module('@/lib/experiments-store', () => ({
  getTeamExperiment: mockGet,
  findOtherRunning: mockFindOtherRunning,
  applyExperimentUpdate: mockApply,
}));

import { GET, PATCH } from './route';

const T0 = new Date('2026-01-01T00:00:00.000Z');
function row(over: Record<string, unknown> = {}) {
  return {
    id: ID, teamId: TEAM, key: 'k', title: 'T', hypothesis: null,
    status: 'draft', kind: 'model_routing', treatmentFraction: 0.5, policyVersion: 1, config: { a: 1 },
    visibility: 'admins', decision: null, createdBy: null, startedAt: null, concludedAt: null,
    createdAt: T0, updatedAt: T0, ...over,
  };
}

const as = (role: Role) => { viewer = { ok: true, viewer: { teamId: TEAM, role, userId: 'u-1' } }; };
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });
const get = (id = ID) => GET(new NextRequest(`http://localhost/api/experiments/${id}`), ctx(id));
const patch = (body: unknown, id = ID) => PATCH(new NextRequest(`http://localhost/api/experiments/${id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), ctx(id));

let stored: any;
beforeEach(() => {
  mockGet.mockReset();
  mockFindOtherRunning.mockReset();
  mockApply.mockReset();
  stored = row();
  mockGet.mockImplementation(async () => stored);
  mockFindOtherRunning.mockResolvedValue(null);
  mockApply.mockImplementation(async (_t: string, _id: string, _exp: any, set: any) => ({ ...stored, ...set }));
});

// ── Auth matrix: role × visibility, for reads and writes ────────────────────

describe('GET /api/experiments/[id] — visibility', () => {
  const cases: [Role, 'team' | 'admins', number][] = [
    ['member', 'team', 200],
    ['member', 'admins', 404],
    ['admin', 'team', 200],
    ['admin', 'admins', 200],
    ['owner', 'team', 200],
    ['owner', 'admins', 200],
  ];
  it.each(cases)('%s × %s → %d', async (role, visibility, status) => {
    as(role);
    stored = row({ visibility });
    const res = await get();
    expect(res.status).toBe(status);
  });

  it('member: an admins-only experiment is indistinguishable from a missing one', async () => {
    as('member');
    stored = row({ visibility: 'admins' });
    const hidden = await get();
    stored = null;
    const missing = await get();
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
  });

  it('looks the id up inside the viewer team only', async () => {
    as('admin');
    await get();
    expect(mockGet).toHaveBeenCalledWith(TEAM, ID);
  });

  it('a non-uuid id is a 404 without touching the db', async () => {
    as('admin');
    const res = await get('not-a-uuid');
    expect(res.status).toBe(404);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('auth failure passes through', async () => {
    viewer = { ok: false, status: 401, error: 'Unauthorized' };
    expect((await get()).status).toBe(401);
  });
});

describe('PATCH /api/experiments/[id] — auth', () => {
  const cases: [Role, 'team' | 'admins', number][] = [
    // Member on a team-visible experiment knows it exists → honest 403.
    ['member', 'team', 403],
    // Member on an admins-only one must not learn it exists → 404, not 403.
    ['member', 'admins', 404],
    ['admin', 'team', 200],
    ['admin', 'admins', 200],
    ['owner', 'team', 200],
    ['owner', 'admins', 200],
  ];
  it.each(cases)('%s × %s → %d', async (role, visibility, status) => {
    as(role);
    stored = row({ visibility });
    const res = await patch({ title: 'renamed' });
    expect(res.status).toBe(status);
    if (status !== 200) expect(mockApply).not.toHaveBeenCalled();
  });
});

// ── Status transitions ──────────────────────────────────────────────────────

describe('PATCH /api/experiments/[id] — transitions', () => {
  it('draft → running stamps startedAt and guards the update on the other-running check', async () => {
    as('admin');
    const res = await patch({ status: 'running' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.experiment.status).toBe('running');
    expect(body.experiment.startedAt).not.toBeNull();
    const [teamId, id, expected, set, guard] = mockApply.mock.calls[0] as any[];
    expect(teamId).toBe(TEAM);
    expect(id).toBe(ID);
    expect(expected).toEqual({ status: 'draft', policyVersion: 1 });
    expect(set.startedAt).toBeInstanceOf(Date);
    expect(guard).toEqual({ kind: 'model_routing' });
  });

  it('409 when another model_routing experiment is already running on the team', async () => {
    as('owner');
    mockFindOtherRunning.mockResolvedValue({ id: OTHER_ID, key: 'other' });
    const res = await patch({ status: 'running' });
    expect(res.status).toBe(409);
    expect((await res.json()).runningExperimentId).toBe(OTHER_ID);
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockFindOtherRunning).toHaveBeenCalledWith(TEAM, 'model_routing', ID);
  });

  it('resume from paused also checks for another running experiment', async () => {
    as('admin');
    stored = row({ status: 'paused', startedAt: T0 });
    mockFindOtherRunning.mockResolvedValue({ id: OTHER_ID, key: 'other' });
    expect((await patch({ status: 'running' })).status).toBe(409);
  });

  it('409 when the guarded update loses a race (row changed or a concurrent start won)', async () => {
    as('admin');
    mockApply.mockResolvedValue(null);
    expect((await patch({ status: 'running' })).status).toBe(409);
  });

  it('running → paused does not run the single-running guard', async () => {
    as('admin');
    stored = row({ status: 'running', startedAt: T0 });
    const res = await patch({ status: 'paused' });
    expect(res.status).toBe(200);
    expect(mockFindOtherRunning).not.toHaveBeenCalled();
    expect((mockApply.mock.calls[0] as any[])[4]).toBeNull();
  });

  it('conclude without a decision → 400; with one → 200 and terminal afterwards', async () => {
    as('admin');
    stored = row({ status: 'running', startedAt: T0 });
    expect((await patch({ status: 'concluded' })).status).toBe(400);
    const ok = await patch({ status: 'concluded', decision: 'Keep the router as is.' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).experiment.decision).toBe('Keep the router as is.');

    stored = row({ status: 'concluded', startedAt: T0, decision: 'd', concludedAt: T0 });
    for (const body of [{ status: 'running' }, { status: 'paused' }, { title: 'x' }]) {
      expect((await patch(body)).status).toBe(409);
    }
  });

  it.each([
    ['draft', 'paused'],
    ['running', 'draft'],
  ] as const)('%s → %s is 409', async (from, to) => {
    as('admin');
    stored = row({ status: from, startedAt: from === 'draft' ? null : T0 });
    expect((await patch({ status: to })).status).toBe(409);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('400 on invalid JSON', async () => {
    as('admin');
    const res = await PATCH(new NextRequest(`http://localhost/api/experiments/${ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{nope',
    }), ctx());
    expect(res.status).toBe(400);
  });
});

// ── policyVersion ───────────────────────────────────────────────────────────

describe('PATCH /api/experiments/[id] — policyVersion', () => {
  it('changing the fraction while running bumps the version, locked on the old one', async () => {
    as('admin');
    stored = row({ status: 'running', startedAt: T0, policyVersion: 2 });
    const res = await patch({ treatmentFraction: 0.25 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policyVersionBumped).toBe(true);
    expect(body.experiment.policyVersion).toBe(3);
    const [, , expected, set] = mockApply.mock.calls[0] as any[];
    expect(expected).toEqual({ status: 'running', policyVersion: 2 });
    expect(set.policyVersion).toBe(3);
  });

  it('changing the config while running bumps the version', async () => {
    as('owner');
    stored = row({ status: 'running', startedAt: T0 });
    const body = await (await patch({ config: { a: 2 } })).json();
    expect(body.experiment.policyVersion).toBe(2);
  });

  it('a title edit while running does not bump', async () => {
    as('admin');
    stored = row({ status: 'running', startedAt: T0 });
    const body = await (await patch({ title: 'x' })).json();
    expect(body.policyVersionBumped).toBe(false);
    expect(body.experiment.policyVersion).toBe(1);
  });

  it('a fraction change in draft does not bump', async () => {
    as('admin');
    const body = await (await patch({ treatmentFraction: 0.3 })).json();
    expect(body.experiment.policyVersion).toBe(1);
  });
});

// A per-task token reads a team-visible experiment on its own task's
// workspace's team, and changes none.
describe('/api/experiments/[id] — per-task token', () => {
  const bearer = (qs = '', init: Record<string, unknown> = {}) =>
    new NextRequest(`http://localhost/api/experiments/${ID}${qs}`, { ...init, headers: { authorization: `Bearer ${taskToken()}`, 'Content-Type': 'application/json' } });

  beforeEach(() => {
    mockTaskViewer.mockClear();
    mockResolveViewer.mockClear();
  });

  it('reads a team-visible experiment through its own workspace', async () => {
    stored = row({ visibility: 'team' });
    const res = await GET(bearer(), ctx());
    expect(res.status).toBe(200);
    expect(mockTaskViewer).toHaveBeenCalledWith('ws-own', 'acct-1');
    expect(mockResolveViewer).not.toHaveBeenCalled();
  });

  it('does not see an admins-only experiment', async () => {
    stored = row({ visibility: 'admins' });
    expect((await GET(bearer(), ctx())).status).toBe(404);
  });

  it('404s another workspace, before resolving any team', async () => {
    stored = row({ visibility: 'team' });
    const res = await GET(bearer('?workspaceId=ws-other'), ctx());
    expect(res.status).toBe(404);
    expect(mockTaskViewer).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it.each([{ status: 'running' }, { status: 'paused' }, { title: 'x' }])('403s PATCH %o, and writes nothing', async (body) => {
    stored = row({ visibility: 'team' });
    const res = await PATCH(bearer('', { method: 'PATCH', body: JSON.stringify(body) }), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('A task token cannot change experiments');
    expect(mockApply).not.toHaveBeenCalled();
  });
});
