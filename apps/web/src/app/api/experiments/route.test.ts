import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-a';

type Role = 'member' | 'admin' | 'owner';
let viewer: { ok: true; viewer: { teamId: string; role: Role; userId: string | null } } | { ok: false; status: 401 | 404; error: string };

const mockResolveViewer = mock(async () => viewer);
const mockList = mock(async (_teamId: string) => [] as any[]);
const mockInsert = mock(async (..._args: any[]) => ({}) as any);

// A real per-task token, verified by the real authenticateTaskScopedCaller.
process.env.AUTH_SECRET ||= 'test-task-token-secret';
const { mintTaskToken } = await import('@/lib/task-token');
const KEY_HASH = 'key-hash';
const taskToken = (workspaceId = 'ws-own') =>
  mintTaskToken({ accountId: 'acct-1', taskId: 'task-own', workspaceId, keyHash: KEY_HASH })!.token;
const mockAccountFind = mock(async () => ({ id: 'acct-1', apiKey: KEY_HASH, teamId: TEAM, level: 'admin', scopes: null, workspaceIds: null, expiresAt: null }));
const mockAuthenticateApiKey = mock(async () => null as any);
mock.module('@buildd/core/db', () => ({ db: { query: { accounts: { findFirst: mockAccountFind } } } }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
const mockTaskViewer = mock(async (_workspaceId: string, accountId: string) =>
  ({ ok: true, viewer: { teamId: TEAM, role: 'member', userId: null, accountId } }) as any);

mock.module('@/lib/experiment-access', () => ({
  resolveExperimentViewer: mockResolveViewer,
  taskTokenExperimentViewer: mockTaskViewer,
  bearerOf: (req: NextRequest) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null,
}));
mock.module('@/lib/experiments-store', () => ({
  listTeamExperiments: mockList,
  insertExperiment: mockInsert,
}));

const mockHealth = mock(async (..._a: any[]) => [] as any[]);
mock.module('@buildd/core/experiment-health-source', () => ({ runExperimentHealth: mockHealth }));

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

  it('attaches enrolment health for running experiments only, keyed by id', async () => {
    as('admin');
    mockList.mockResolvedValue([
      row({ id: 'r', key: 'live', status: 'running', visibility: 'team' }),
      row({ id: 'd', key: 'draft', status: 'draft', visibility: 'team' }),
    ]);
    const finding = { code: 'no_recent_assignments', severity: 'critical', detail: 'no unit enrolled in 4d' };
    mockHealth.mockReset();
    mockHealth.mockResolvedValue([finding]);
    const body = await (await get()).json();
    expect(body.health).toEqual({ r: [finding] });
    expect(mockHealth).toHaveBeenCalledTimes(1);
  });

  it('a failing health check leaves that experiment out, the list still answers', async () => {
    as('admin');
    mockList.mockResolvedValue([row({ id: 'r', status: 'running', visibility: 'team' })]);
    mockHealth.mockReset();
    mockHealth.mockRejectedValue(new Error('db down'));
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).health).toEqual({});
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

// A per-task token lists team-visible experiments on its own task's
// workspace's team, without the team-wide enrolment health, and creates none.
describe('/api/experiments — per-task token', () => {
  const bearer = (path: string, token: string, init: Record<string, unknown> = {}) =>
    new NextRequest(`http://localhost${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

  beforeEach(() => {
    mockTaskViewer.mockClear();
    mockHealth.mockReset();
    mockHealth.mockResolvedValue([{ code: 'no_recent_assignments', severity: 'critical', detail: 'team-wide' }]);
    mockList.mockResolvedValue([
      row({ id: 'a', key: 'hidden', visibility: 'admins', status: 'running' }),
      row({ id: 'b', key: 'shared', visibility: 'team', status: 'running' }),
    ]);
  });

  it('lists team-visible experiments through its own workspace, without enrolment health', async () => {
    const res = await GET(bearer('/api/experiments', taskToken()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.experiments.map((e: any) => e.key)).toEqual(['shared']);
    expect(body.canManage).toBe(false);
    expect(body.health).toEqual({});
    expect(mockHealth).not.toHaveBeenCalled();
    expect(mockTaskViewer).toHaveBeenCalledWith('ws-own', 'acct-1');
    expect(mockResolveViewer).not.toHaveBeenCalled();
  });

  it('accepts its own workspace named explicitly', async () => {
    const res = await GET(bearer('/api/experiments?workspaceId=ws-own', taskToken()));
    expect(res.status).toBe(200);
  });

  it('404s another workspace, before resolving any team', async () => {
    const res = await GET(bearer('/api/experiments?workspaceId=ws-other', taskToken()));
    expect(res.status).toBe(404);
    expect(mockTaskViewer).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('401s a forged task token', async () => {
    const res = await GET(bearer('/api/experiments', `${taskToken()}x`));
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('403s create, and writes nothing', async () => {
    const res = await POST(bearer('/api/experiments', taskToken(), { method: 'POST', body: JSON.stringify({ key: 'k', title: 't' }) }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('A task token cannot create experiments');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('an account key still resolves through resolveExperimentViewer, health included', async () => {
    as('admin');
    const body = await (await GET(bearer('/api/experiments', 'bld_test'))).json();
    expect(mockResolveViewer).toHaveBeenCalled();
    expect(mockTaskViewer).not.toHaveBeenCalled();
    expect(Object.keys(body.health).sort()).toEqual(['a', 'b']);
  });
});
