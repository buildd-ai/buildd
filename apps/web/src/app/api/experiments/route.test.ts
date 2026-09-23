import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-a';

type Role = 'member' | 'admin' | 'owner';
let viewer: { ok: true; viewer: { teamId: string; role: Role; userId: string | null } } | { ok: false; status: 401 | 404; error: string };

const mockResolveViewer = mock(async () => viewer);
const mockList = mock(async (_teamId: string) => [] as any[]);
const mockInsert = mock(async (..._args: any[]) => ({}) as any);

mock.module('@/lib/experiment-access', () => ({ resolveExperimentViewer: mockResolveViewer }));
mock.module('@/lib/experiments-store', () => ({
  listTeamExperiments: mockList,
  insertExperiment: mockInsert,
}));

import { GET, POST } from './route';

const T0 = new Date('2026-01-01T00:00:00.000Z');
function row(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111', teamId: TEAM, key: 'k', title: 'T', hypothesis: null,
    status: 'draft', kind: 'model_routing', treatmentFraction: 0.5, policyVersion: 1, config: {},
    visibility: 'admins', decision: null, createdBy: null, startedAt: null, concludedAt: null,
    createdAt: T0, updatedAt: T0, ...over,
  };
}

function as(role: Role) {
  viewer = { ok: true, viewer: { teamId: TEAM, role, userId: 'u-1' } };
}

const get = () => GET(new NextRequest('http://localhost/api/experiments'));
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/experiments', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => {
  mockList.mockReset();
  mockInsert.mockReset();
  mockResolveViewer.mockClear();
  mockList.mockResolvedValue([
    row({ id: 'a', key: 'hidden', visibility: 'admins' }),
    row({ id: 'b', key: 'shared', visibility: 'team' }),
  ]);
});

describe('GET /api/experiments', () => {
  it('401 passes through when unauthenticated', async () => {
    viewer = { ok: false, status: 401, error: 'Unauthorized' };
    const res = await get();
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('member sees team-visible experiments only; admins-only rows are absent, not flagged', async () => {
    as('member');
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.experiments.map((e: any) => e.key)).toEqual(['shared']);
    expect(JSON.stringify(body)).not.toContain('hidden');
    expect(body.canManage).toBe(false);
  });

  it.each(['admin', 'owner'] as const)('%s sees both visibilities and canManage', async (role) => {
    as(role);
    const body = await (await get()).json();
    expect(body.experiments.map((e: any) => e.key)).toEqual(['hidden', 'shared']);
    expect(body.canManage).toBe(true);
  });

  it('lists only the viewer team', async () => {
    as('admin');
    await get();
    expect(mockList).toHaveBeenCalledWith(TEAM);
  });

  it('never returns teamId or createdBy', async () => {
    as('owner');
    const body = await (await get()).json();
    for (const e of body.experiments) {
      expect('teamId' in e).toBe(false);
      expect('createdBy' in e).toBe(false);
    }
  });
});

describe('POST /api/experiments', () => {
  const VALID = { key: 'premium-vs-standard', title: 'Premium vs standard', hypothesis: 'h' };

  it('member gets 403 and nothing is written', async () => {
    as('member');
    const res = await post(VALID);
    expect(res.status).toBe(403);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it.each(['admin', 'owner'] as const)('%s creates a draft on the viewer team', async (role) => {
    as(role);
    mockInsert.mockResolvedValue(row({ key: VALID.key, title: VALID.title }));
    const res = await post({ ...VALID, status: 'running' });
    expect(res.status).toBe(201);
    const [teamId, createdBy, values] = mockInsert.mock.calls[0] as any[];
    expect(teamId).toBe(TEAM);
    expect(createdBy).toBe('u-1');
    expect(values.visibility).toBe('admins');
    expect('status' in values).toBe(false);
    expect((await res.json()).experiment.status).toBe('draft');
  });

  it('400 on invalid body', async () => {
    as('admin');
    expect((await post({ key: 'k' })).status).toBe(400);
    expect((await post({ key: 'k', title: 't', treatmentFraction: 2 })).status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('409 on a duplicate key', async () => {
    as('admin');
    mockInsert.mockResolvedValue('duplicate_key');
    expect((await post(VALID)).status).toBe(409);
  });
});
