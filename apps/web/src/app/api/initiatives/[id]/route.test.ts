import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockInitiativesFindFirst = mock(() => ({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', workspaceId: null }) as any);
const mockArtifactsFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockTeamMembersFindFirst = mock(() => ({ userId: 'user-2' }) as any);
let updatedValues: any = null;
let deleteCalled = false;
const mockUpdate = mock(() => ({
  set: mock((vals: any) => {
    updatedValues = vals;
    return { where: mock(() => ({ returning: mock(() => [{ id: '11111111-1111-4111-8111-111111111111', ...vals }]) })) };
  }),
}));
const mockDelete = mock(() => ({ where: mock(() => { deleteCalled = true; return Promise.resolve(); }) }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));
mock.module('@/lib/team-access', () => ({
  resolveAccountTeamIds: mockResolveAccountTeamIds,
  getUserTeamIds: mock(() => Promise.resolve(['team-1'])),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      initiatives: { findFirst: mockInitiativesFindFirst },
      artifacts: { findMany: mockArtifactsFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      teamMembers: { findFirst: mockTeamMembersFindFirst },
    },
    update: () => mockUpdate(),
    delete: () => mockDelete(),
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => args,
  desc: (field: any) => ({ field, type: 'desc' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  initiatives: { id: 'id' },
  artifacts: { initiativeId: 'initiativeId' },
  workspaces: { id: 'id' },
  teamMembers: { teamId: 'teamId', userId: 'userId' },
}));

import { GET, PATCH, DELETE } from './route';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockAuthenticateApiKey.mockReset();
  mockResolveAccountTeamIds.mockReset();
  mockInitiativesFindFirst.mockReset();
  mockArtifactsFindMany.mockReset();
  mockUpdate.mockReset();
  mockDelete.mockReset();
  updatedValues = null;
  deleteCalled = false;

  mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
  mockAuthenticateApiKey.mockReturnValue(null);
  mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
  mockArtifactsFindMany.mockResolvedValue([]);
  mockUpdate.mockImplementation(() => ({
    set: mock((vals: any) => {
      updatedValues = vals;
      return { where: mock(() => ({ returning: mock(() => [{ id: '11111111-1111-4111-8111-111111111111', ...vals }]) })) };
    }),
  }));
  mockDelete.mockImplementation(() => ({ where: mock(() => { deleteCalled = true; return Promise.resolve(); }) }));
});

describe('GET /api/initiatives/[id]', () => {
  it('returns the initiative with rolled-up mission progress + artifacts', async () => {
    mockInitiativesFindFirst.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111', title: 'Platform', status: 'active', teamId: 'team-1', workspaceId: null,
      missions: [
        { id: 'm-1', title: 'A', status: 'completed', tasks: [{ id: 't1', status: 'completed' }] },
      ],
    });
    mockArtifactsFindMany.mockResolvedValue([{ id: 'a-1', title: 'Roadmap', initiativeId: '11111111-1111-4111-8111-111111111111' }]);

    const res = await GET(new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111'), ctx('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.progress.progress).toBe(100);
    expect(body.progress.status).toBe('completed');
    // Per-mission progress present, raw task arrays stripped
    expect(body.missions[0].progress).toBe(100);
    expect(body.missions[0].tasks).toBeUndefined();
    expect(body.artifacts).toHaveLength(1);
  });

  it('does not read the deprecated columns', async () => {
    mockInitiativesFindFirst.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111', title: 'Platform', status: 'active', teamId: 'team-1', workspaceId: null, missions: [],
    });
    await GET(new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111'), ctx('11111111-1111-4111-8111-111111111111'));
    const opts = (mockInitiativesFindFirst.mock.calls.at(-1) as any[])[0];
    expect(opts.columns).toBeDefined();
    for (const col of ['kpis', 'kpiState', 'autoVerify', 'progressCache']) expect(opts.columns[col]).toBeUndefined();
    expect(opts.columns.targetDate).toBe(true);
  });

  it('404 when the initiative is on another team', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: '99999999-9999-4999-8999-999999999999', teamId: 'team-other', workspaceId: null, missions: [] });
    mockWorkspacesFindFirst.mockResolvedValue(null);
    const res = await GET(new NextRequest('http://localhost/api/initiatives/99999999-9999-4999-8999-999999999999'), ctx('99999999-9999-4999-8999-999999999999'));
    expect(res.status).toBe(404);
  });

  it('401 when unauthenticated', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    const res = await GET(new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111'), ctx('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-UUID id without querying the db', async () => {
    const res = await GET(new NextRequest('http://localhost/api/initiatives/not-a-uuid'), ctx('not-a-uuid'));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(mockInitiativesFindFirst).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/initiatives/[id]', () => {
  it('updates title and status', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', workspaceId: null });
    const res = await PATCH(new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH', body: JSON.stringify({ title: 'Renamed', status: 'completed' }),
    }), ctx('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(200);
    expect(updatedValues.title).toBe('Renamed');
    expect(updatedValues.status).toBe('completed');
  });

  it('rejects an invalid status', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', workspaceId: null });
    const res = await PATCH(new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH', body: JSON.stringify({ status: 'bogus' }),
    }), ctx('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(400);
  });

  it('ignores the removed KPI fields: nothing writes kpis or autoVerify', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', workspaceId: null });
    const res = await PATCH(new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH', body: JSON.stringify({ title: 'T', kpis: [], autoVerify: false }),
    }), ctx('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(200);
    expect('kpis' in updatedValues).toBe(false);
    expect('autoVerify' in updatedValues).toBe(false);
  });

  it('accepts the planned status', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', workspaceId: null });
    const res = await PATCH(new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH', body: JSON.stringify({ status: 'planned' }),
    }), ctx('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(200);
    expect(updatedValues.status).toBe('planned');
  });

  it('sets and clears the target date, and rejects anything but YYYY-MM-DD', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', workspaceId: null });
    const patch = (body: unknown) => PATCH(new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH', body: JSON.stringify(body),
    }), ctx('11111111-1111-4111-8111-111111111111'));

    expect((await patch({ targetDate: '2026-11-01' })).status).toBe(200);
    expect(updatedValues.targetDate).toBe('2026-11-01');

    expect((await patch({ targetDate: null })).status).toBe(200);
    expect(updatedValues.targetDate).toBeNull();

    updatedValues = null;
    expect((await patch({ targetDate: 'next week' })).status).toBe(400);
    expect((await patch({ targetDate: '2026-02-30' })).status).toBe(400);
    expect(updatedValues).toBeNull();
  });

  it('sets an owner who belongs to the team, and refuses one who does not', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', workspaceId: null });
    const patch = (body: unknown) => PATCH(new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH', body: JSON.stringify(body),
    }), ctx('11111111-1111-4111-8111-111111111111'));

    mockTeamMembersFindFirst.mockResolvedValue({ userId: 'user-2' });
    expect((await patch({ ownerUserId: 'user-2' })).status).toBe(200);
    expect(updatedValues.ownerUserId).toBe('user-2');

    updatedValues = null;
    mockTeamMembersFindFirst.mockResolvedValue(null);
    expect((await patch({ ownerUserId: 'user-9' })).status).toBe(400);
    expect(updatedValues).toBeNull();

    expect((await patch({ ownerUserId: null })).status).toBe(200);
    expect(updatedValues.ownerUserId).toBeNull();
  });

  it('403 for non-admin API key', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue({ id: 'api-1', level: 'worker', teamId: 'team-1' } as any);
    const res = await PATCH(new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH', body: JSON.stringify({ title: 'X' }),
    }), ctx('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(403);
  });

  it('returns 404 for a non-UUID id without querying the db', async () => {
    const res = await PATCH(new NextRequest('http://localhost/api/initiatives/not-a-uuid', {
      method: 'PATCH', body: JSON.stringify({ title: 'X' }),
    }), ctx('not-a-uuid'));
    expect(res.status).toBe(404);
    expect(mockInitiativesFindFirst).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/initiatives/[id]', () => {
  it('returns 404 for a non-UUID id without querying the db', async () => {
    const res = await DELETE(new NextRequest('http://localhost/api/initiatives/not-a-uuid', { method: 'DELETE' }), ctx('not-a-uuid'));
    expect(res.status).toBe(404);
    expect(mockInitiativesFindFirst).not.toHaveBeenCalled();
    expect(deleteCalled).toBe(false);
  });

  it('deletes the initiative (children are unlinked via FK, not deleted)', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', workspaceId: null });
    const res = await DELETE(new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111', { method: 'DELETE' }), ctx('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(200);
    expect(deleteCalled).toBe(true);
  });

  it('404 for a foreign-team initiative', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: '99999999-9999-4999-8999-999999999999', teamId: 'team-other', workspaceId: null });
    mockWorkspacesFindFirst.mockResolvedValue(null);
    const res = await DELETE(new NextRequest('http://localhost/api/initiatives/99999999-9999-4999-8999-999999999999', { method: 'DELETE' }), ctx('99999999-9999-4999-8999-999999999999'));
    expect(res.status).toBe(404);
    expect(deleteCalled).toBe(false);
  });
});
