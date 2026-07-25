import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockInitiativesFindFirst = mock(() => ({ id: 'init-1', teamId: 'team-1', workspaceId: null }) as any);
const mockArtifactsFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
let updatedValues: any = null;
let deleteCalled = false;
const mockUpdate = mock(() => ({
  set: mock((vals: any) => {
    updatedValues = vals;
    return { where: mock(() => ({ returning: mock(() => [{ id: 'init-1', ...vals }]) })) };
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
      return { where: mock(() => ({ returning: mock(() => [{ id: 'init-1', ...vals }]) })) };
    }),
  }));
  mockDelete.mockImplementation(() => ({ where: mock(() => { deleteCalled = true; return Promise.resolve(); }) }));
});

describe('GET /api/initiatives/[id]', () => {
  it('returns the initiative with rolled-up mission progress + artifacts', async () => {
    mockInitiativesFindFirst.mockResolvedValue({
      id: 'init-1', title: 'Platform', status: 'active', teamId: 'team-1', workspaceId: null,
      missions: [
        { id: 'm-1', title: 'A', status: 'completed', tasks: [{ id: 't1', status: 'completed' }] },
      ],
    });
    mockArtifactsFindMany.mockResolvedValue([{ id: 'a-1', title: 'Roadmap', initiativeId: 'init-1' }]);

    const res = await GET(new NextRequest('http://localhost/api/initiatives/init-1'), ctx('init-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.progress.progress).toBe(100);
    expect(body.progress.status).toBe('completed');
    // Per-mission progress present, raw task arrays stripped
    expect(body.missions[0].progress).toBe(100);
    expect(body.missions[0].tasks).toBeUndefined();
    expect(body.artifacts).toHaveLength(1);
  });

  it('404 when the initiative is on another team', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: 'init-x', teamId: 'team-other', workspaceId: null, missions: [] });
    mockWorkspacesFindFirst.mockResolvedValue(null);
    const res = await GET(new NextRequest('http://localhost/api/initiatives/init-x'), ctx('init-x'));
    expect(res.status).toBe(404);
  });

  it('401 when unauthenticated', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    const res = await GET(new NextRequest('http://localhost/api/initiatives/init-1'), ctx('init-1'));
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/initiatives/[id]', () => {
  it('updates title and status', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: 'init-1', teamId: 'team-1', workspaceId: null });
    const res = await PATCH(new NextRequest('http://localhost/api/initiatives/init-1', {
      method: 'PATCH', body: JSON.stringify({ title: 'Renamed', status: 'completed' }),
    }), ctx('init-1'));
    expect(res.status).toBe(200);
    expect(updatedValues.title).toBe('Renamed');
    expect(updatedValues.status).toBe('completed');
  });

  it('rejects an invalid status', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: 'init-1', teamId: 'team-1', workspaceId: null });
    const res = await PATCH(new NextRequest('http://localhost/api/initiatives/init-1', {
      method: 'PATCH', body: JSON.stringify({ status: 'bogus' }),
    }), ctx('init-1'));
    expect(res.status).toBe(400);
  });

  it('403 for non-admin API key', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue({ id: 'api-1', level: 'worker', teamId: 'team-1' } as any);
    const res = await PATCH(new NextRequest('http://localhost/api/initiatives/init-1', {
      method: 'PATCH', body: JSON.stringify({ title: 'X' }),
    }), ctx('init-1'));
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/initiatives/[id]', () => {
  it('deletes the initiative (children are unlinked via FK, not deleted)', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: 'init-1', teamId: 'team-1', workspaceId: null });
    const res = await DELETE(new NextRequest('http://localhost/api/initiatives/init-1', { method: 'DELETE' }), ctx('init-1'));
    expect(res.status).toBe(200);
    expect(deleteCalled).toBe(true);
  });

  it('404 for a foreign-team initiative', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: 'init-x', teamId: 'team-other', workspaceId: null });
    mockWorkspacesFindFirst.mockResolvedValue(null);
    const res = await DELETE(new NextRequest('http://localhost/api/initiatives/init-x', { method: 'DELETE' }), ctx('init-x'));
    expect(res.status).toBe(404);
    expect(deleteCalled).toBe(false);
  });
});
