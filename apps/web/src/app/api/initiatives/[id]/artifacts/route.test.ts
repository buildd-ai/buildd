import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockInitiativesFindFirst = mock(() => ({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', workspaceId: null }) as any);
const mockMissionsFindMany = mock(() => [] as any[]);
const mockArtifactsFindMany = mock(() => [] as any[]);
const mockArtifactsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
let insertedValues: any = null;

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: mockResolveAccountTeamIds }));
mock.module('@/lib/app-url', () => ({ appBaseUrl: () => 'https://buildd.test' }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      initiatives: { findFirst: mockInitiativesFindFirst },
      missions: { findMany: mockMissionsFindMany },
      artifacts: { findMany: mockArtifactsFindMany, findFirst: mockArtifactsFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: () => ({
      values: (vals: any) => ({
        returning: () => {
          insertedValues = vals;
          return [{ id: 'artifact-1', ...vals }];
        },
      }),
    }),
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  initiatives: { id: 'id', teamId: 'teamId', workspaceId: 'workspaceId' },
  missions: { initiativeId: 'initiativeId', id: 'id' },
  artifacts: { initiativeId: 'initiativeId', missionId: 'missionId', workspaceId: 'workspaceId', key: 'key' },
  workspaces: { id: 'id', accessMode: 'accessMode' },
}));

import { GET, POST } from './route';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockAuthenticateApiKey.mockReset();
  mockResolveAccountTeamIds.mockReset();
  mockInitiativesFindFirst.mockReset();
  mockMissionsFindMany.mockReset();
  mockArtifactsFindMany.mockReset();
  mockArtifactsFindFirst.mockReset();
  mockWorkspacesFindFirst.mockReset();
  insertedValues = null;

  mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
  mockAuthenticateApiKey.mockReturnValue(null);
  mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
  mockInitiativesFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', workspaceId: null });
  mockMissionsFindMany.mockResolvedValue([]);
  mockArtifactsFindMany.mockResolvedValue([]);
  mockArtifactsFindFirst.mockResolvedValue(null);
});

describe('GET /api/initiatives/[id]/artifacts', () => {
  it('returns 404 for a non-UUID id without querying the db', async () => {
    const res = await GET(new NextRequest('http://localhost/api/initiatives/not-a-uuid/artifacts'), ctx('not-a-uuid'));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(mockInitiativesFindFirst).not.toHaveBeenCalled();
  });

  it('returns rolled-up artifacts', async () => {
    mockArtifactsFindMany.mockResolvedValue([{ id: 'a-1', title: 'Roadmap' }]);
    const res = await GET(new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111/artifacts'), ctx('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifacts).toHaveLength(1);
  });
});

describe('POST /api/initiatives/[id]/artifacts', () => {
  it('returns 404 for a non-UUID id without querying the db', async () => {
    const req = new NextRequest('http://localhost/api/initiatives/not-a-uuid/artifacts', {
      method: 'POST',
      body: JSON.stringify({ type: 'summary', title: 'T' }),
    });
    const res = await POST(req, ctx('not-a-uuid'));
    expect(res.status).toBe(404);
    expect(mockInitiativesFindFirst).not.toHaveBeenCalled();
  });

  it('creates an initiative-level artifact', async () => {
    const req = new NextRequest('http://localhost/api/initiatives/11111111-1111-4111-8111-111111111111/artifacts', {
      method: 'POST',
      body: JSON.stringify({ type: 'summary', title: 'Roadmap' }),
    });
    const res = await POST(req, ctx('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(200);
    expect(insertedValues.title).toBe('Roadmap');
    expect(insertedValues.initiativeId).toBe('11111111-1111-4111-8111-111111111111');
  });
});
