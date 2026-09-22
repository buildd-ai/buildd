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

mock.module('@/lib/experiment-access', () => ({ resolveExperimentViewer: mockResolveViewer }));
mock.module('@/lib/experiments-store', () => ({ getTeamExperiment: mockGet }));
mock.module('@buildd/core/experiment-readout-source', () => ({ runExperimentReadout: mockRun }));

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
  mockRun.mockClear();
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
});
