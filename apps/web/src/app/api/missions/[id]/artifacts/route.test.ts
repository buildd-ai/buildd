import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockMissionsFindFirst = mock(() => null as any);
const mockTeamMembersFindFirst = mock(() => null as any);
const mockArtifactsFindFirst = mock(() => null as any);
const mockArtifactsFindMany = mock(() => [] as any[]);

let insertedArtifactValues: any = null;
const mockArtifactsInsert = mock(() => ({
  values: mock((vals: any) => {
    insertedArtifactValues = vals;
    return {
      returning: mock(() => [{
        id: 'art-1',
        shareToken: 'tok-abc',
        ...vals,
      }]),
    };
  }),
}));

const mockArtifactsUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => [{
        id: 'art-existing',
        shareToken: 'tok-existing',
      }]),
    })),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      teamMembers: { findFirst: mockTeamMembersFindFirst },
      artifacts: { findFirst: mockArtifactsFindFirst, findMany: mockArtifactsFindMany },
    },
    insert: () => mockArtifactsInsert(),
    update: () => mockArtifactsUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => args,
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id', teamId: 'teamId' },
  teamMembers: { teamId: 'teamId', role: 'role', userId: 'userId' },
  artifacts: {
    id: 'id',
    workspaceId: 'workspaceId',
    missionId: 'missionId',
    key: 'key',
  },
}));

mock.module('@buildd/shared', () => ({
  ArtifactType: {
    CONTENT: 'content',
    REPORT: 'report',
    DATA: 'data',
    LINK: 'link',
    SUMMARY: 'summary',
    FILE: 'file',
    ANALYSIS: 'analysis',
    RECOMMENDATION: 'recommendation',
  },
}));

import { POST, GET } from './route';

const mockParams = Promise.resolve({ id: 'mission-1' });

function createRequest(options: {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
} = {}): NextRequest {
  const { method = 'GET', body, headers: extraHeaders } = options;
  const headers: Record<string, string> = { ...extraHeaders };
  if (body) headers['content-type'] = 'application/json';
  const init: RequestInit = { method, headers: new Headers(headers) };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/missions/mission-1/artifacts', init);
}

describe('POST /api/missions/[id]/artifacts', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockMissionsFindFirst.mockReset();
    mockTeamMembersFindFirst.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockArtifactsInsert.mockReset();
    insertedArtifactValues = null;

    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    mockArtifactsInsert.mockReturnValue({
      values: mock((vals: any) => {
        insertedArtifactValues = vals;
        return {
          returning: mock(() => [{
            id: 'art-1',
            shareToken: 'tok-abc',
            ...vals,
          }]),
        };
      }),
    });
  });

  it('returns 401 when not authenticated', async () => {
    const req = createRequest({ method: 'POST', body: { type: 'summary', title: 'Test' } });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 404 when mission not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue(null);

    const req = createRequest({
      method: 'POST',
      body: { type: 'summary', title: 'Plan' },
      headers: { authorization: 'Bearer bld_test' },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('returns 404 when mission belongs to different team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-other', workspaceId: 'ws-1' });

    const req = createRequest({
      method: 'POST',
      body: { type: 'summary', title: 'Plan' },
      headers: { authorization: 'Bearer bld_test' },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('creates artifact on mission without worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: 'ws-1' });

    const req = createRequest({
      method: 'POST',
      body: { type: 'summary', title: 'iOS MVP Plan', content: '# Plan content' },
      headers: { authorization: 'Bearer bld_test' },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.artifact.title).toBe('iOS MVP Plan');
    expect(insertedArtifactValues).not.toBeNull();
    expect(insertedArtifactValues.workerId).toBeNull();
    expect(insertedArtifactValues.missionId).toBe('mission-1');
    expect(insertedArtifactValues.workspaceId).toBe('ws-1');
  });

  it('rejects invalid artifact type', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      method: 'POST',
      body: { type: 'invalid_type', title: 'Bad' },
      headers: { authorization: 'Bearer bld_test' },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('requires title', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      method: 'POST',
      body: { type: 'summary' },
      headers: { authorization: 'Bearer bld_test' },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('requires url for link type', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      method: 'POST',
      body: { type: 'link', title: 'My Link' },
      headers: { authorization: 'Bearer bld_test' },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('works with session auth', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      method: 'POST',
      body: { type: 'summary', title: 'Session Artifact', content: 'test' },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/missions/[id]/artifacts', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockMissionsFindFirst.mockReset();
    mockTeamMembersFindFirst.mockReset();
    mockArtifactsFindMany.mockReset();

    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);
  });

  it('returns 401 when not authenticated', async () => {
    const req = createRequest();
    const res = await GET(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 404 when mission not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue(null);

    const req = createRequest({ headers: { authorization: 'Bearer bld_test' } });
    const res = await GET(req, { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('lists artifacts for a mission', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1' });
    mockArtifactsFindMany.mockResolvedValue([
      { id: 'art-1', type: 'summary', title: 'Plan' },
    ]);

    const req = createRequest({ headers: { authorization: 'Bearer bld_test' } });
    const res = await GET(req, { params: mockParams });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.artifacts).toHaveLength(1);
    expect(data.artifacts[0].title).toBe('Plan');
  });
});
