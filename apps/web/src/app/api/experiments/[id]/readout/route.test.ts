import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-a';
const ID = '11111111-1111-4111-8111-111111111111';

type Role = 'member' | 'admin' | 'owner';
let viewer: any;
let stored: any;

const mockResolveViewer = mock(async () => viewer);
const mockGet = mock(async () => stored);
const mockRun = mock(async (..._a: any[]) => ({ verdict: 'insufficient_n' }) as any);

// The visibility check reads the team's permission overrides; none stored.
mock.module('@buildd/core/db', () => ({ db: { query: { teams: { findFirst: async () => null } } } }));
mock.module('@/lib/experiment-access', () => ({
  resolveExperimentViewer: mockResolveViewer,
  bearerOf: (req: NextRequest) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null,
}));
mock.module('@/lib/experiments-store', () => ({ getTeamExperimentForReadout: mockGet }));
mock.module('@buildd/core/experiment-readout-source', () => ({ runExperimentReadout: mockRun }));
const mockTriageRun = mock(async (..._a: any[]) => ({ status: 'underpowered' }) as any);
mock.module('@buildd/core/heartbeat-triage-readout-source', () => ({ runHeartbeatTriageReadout: mockTriageRun }));

const mockPoolRun = mock(async (..._a: any[]) => ({ kind: 'tier_pool', verdict: 'insufficient_n', arms: [] }) as any);
mock.module('@buildd/core/tier-pool-admin', () => ({ runTierPoolReadout: mockPoolRun }));
const mockHealth = mock(async (..._a: any[]) => [] as any[]);
mock.module('@buildd/core/experiment-health-source', () => ({ runExperimentHealth: mockHealth }));

import { GET } from './route';

const T0 = new Date('2026-01-01T00:00:00.000Z');
function row(over: Record<string, unknown> = {}) {
  return {
    id: ID, teamId: TEAM, key: 'k', title: 'T', hypothesis: null,
    status: 'running', kind: 'model_routing', treatmentFraction: 0.5, policyVersion: 3,
    config: { minSamplePerArm: 12 }, visibility: 'admins', decision: null, createdBy: null,
    startedAt: T0, concludedAt: null, createdAt: T0, updatedAt: T0, ...over,
  };
}
const as = (role: Role) => { viewer = { ok: true, viewer: { teamId: TEAM, role, userId: null } }; };
const get = (qs = '') => GET(new NextRequest(`http://localhost/api/experiments/${ID}/readout${qs}`), { params: Promise.resolve({ id: ID }) });

beforeEach(() => {
  mockHealth.mockReset();
  mockHealth.mockResolvedValue([]);
  mockRun.mockClear();
  mockPoolRun.mockClear();
  mockGet.mockClear();
  stored = row();
});

describe('GET /api/experiments/[id]/readout', () => {
  const cases: [Role, 'team' | 'admins', number][] = [
    ['member', 'team', 200],
    ['member', 'admins', 404],
    ['admin', 'admins', 200],
    ['owner', 'admins', 200],
  ];
  it.each(cases)('%s × %s → %d', async (role, visibility, status) => {
    as(role);
    stored = row({ visibility });
    const res = await get();
    expect(res.status).toBe(status);
    if (status === 404) expect(mockRun).not.toHaveBeenCalled();
  });

  it('a heartbeat_triage experiment gets its per-mission readout, not the task one', async () => {
    as('admin');
    stored = row({ kind: 'heartbeat_triage', config: { minSamplePerArm: 7, waitMinConfidence: 0.95 } });
    const body = await (await get()).json();
    expect(body.readout.status).toBe('underpowered');
    expect(mockTriageRun).toHaveBeenCalledWith({ id: ID, policyVersion: 3 }, { minSamplePerArm: 7, waitMinConfidence: 0.95 });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a tier_pool experiment reads its own chat/agent assignment rows, never the task readout (which would be all zeros)', async () => {
    as('admin');
    stored = row({ kind: 'tier_pool', key: 'tier-pool:chat:budget', config: {} });
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readout.kind).toBe('tier_pool');
    expect(mockPoolRun).toHaveBeenCalledWith({ id: ID, policyVersion: 3 });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a kind with no readout is refused out loud, not read as a task experiment', async () => {
    as('admin');
    stored = row({ kind: 'something_new' });
    const res = await get();
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('something_new');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('cbm_access still uses the task readout', async () => {
    as('admin');
    stored = row({ kind: 'cbm_access' });
    expect((await get()).status).toBe(200);
    expect(mockRun).toHaveBeenCalled();
  });

  it('reads the current policy version with the configured minimum sample', async () => {
    as('admin');
    const body = await (await get()).json();
    expect(body.policyVersion).toBe(3);
    expect(body.readout.verdict).toBe('insufficient_n');
    expect(mockRun).toHaveBeenCalledWith({ id: ID, policyVersion: 3 }, { minSamplePerArm: 12 });
  });

  it('?policyVersion reads an earlier version on its own', async () => {
    as('admin');
    await get('?policyVersion=1');
    expect(mockRun).toHaveBeenCalledWith({ id: ID, policyVersion: 1 }, { minSamplePerArm: 12 });
  });

  it('rejects a policyVersion that never existed', async () => {
    as('admin');
    expect((await get('?policyVersion=4')).status).toBe(400);
    expect((await get('?policyVersion=0')).status).toBe(400);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('carries the enrolment health findings of the running experiment', async () => {
    as('admin');
    const finding = { code: 'arm_never_drawn', severity: 'critical', arm: 'treatment', detail: 'arm treatment has 0 units' };
    mockHealth.mockResolvedValue([finding]);
    const body = await (await get()).json();
    expect(body.health).toEqual([finding]);
    expect(mockHealth.mock.calls[0][0]).toMatchObject({ id: ID, kind: 'model_routing', policyVersion: 3 });
  });

  it('a failing health check does not fail the readout', async () => {
    as('admin');
    mockHealth.mockRejectedValue(new Error('db down'));
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).health).toBeNull();
  });
});

// A readout counts tasks across every workspace on the team, so a per-task
// token (confined to one workspace) is refused it outright.
describe('GET /api/experiments/[id]/readout — per-task token', () => {
  it('403s before resolving a viewer or reading anything', async () => {
    as('member');
    stored = row({ visibility: 'team' });
    mockResolveViewer.mockClear();
    const res = await GET(
      new NextRequest(`http://localhost/api/experiments/${ID}/readout`, { headers: { authorization: 'Bearer bldt_x.y' } }),
      { params: Promise.resolve({ id: ID }) },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/task token/);
    expect(mockResolveViewer).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('an account key still gets its readout', async () => {
    as('member');
    stored = row({ visibility: 'team' });
    const res = await GET(
      new NextRequest(`http://localhost/api/experiments/${ID}/readout`, { headers: { authorization: 'Bearer bld_test' } }),
      { params: Promise.resolve({ id: ID }) },
    );
    expect(res.status).toBe(200);
  });
});
