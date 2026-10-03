import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockMissionsFindFirst = mock(() => null as any);
const mockTeamMembersFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
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
  resolveAccountTeamIds: mockResolveAccountTeamIds,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      teamMembers: { findFirst: mockTeamMembersFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      artifacts: { findFirst: mockArtifactsFindFirst, findMany: mockArtifactsFindMany },
    },
    insert: () => mockArtifactsInsert(),
    update: () => mockArtifactsUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => args,
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: any[]) => ({ strings: [...strings], values, as: (alias: string) => ({ sql: [...strings].join('?'), values, alias }) }), {}),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id', teamId: 'teamId' },
  teamMembers: { teamId: 'teamId', role: 'role', userId: 'userId' },
  artifacts: {
    id: 'id',
    workspaceId: 'workspaceId',
    missionId: 'missionId',
    key: 'key',
    type: 'type',
    content: 'content',
    updatedAt: 'updatedAt',
  },
}));

import { POST, GET } from './route';

const mockParams = Promise.resolve({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });

function createRequest(options: {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
  query?: string;
} = {}): NextRequest {
  const { method = 'GET', body, headers: extraHeaders } = options;
  const headers: Record<string, string> = { ...extraHeaders };
  if (body) headers['content-type'] = 'application/json';
  const init: RequestInit = { method, headers: new Headers(headers) };
  if (body) init.body = JSON.stringify(body);
  const qs = options.query ? `?${options.query}` : '';
  return new NextRequest(`http://localhost:3000/api/missions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/artifacts${qs}`, init);
}

describe('POST /api/missions/[id]/artifacts', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReset();
    mockTeamMembersFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
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

  it('404s a non-UUID id (e.g. a short 8-hex id) without querying the db', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    const req = createRequest({
      method: 'POST',
      body: { type: 'summary', title: 'Test' },
      headers: { authorization: 'Bearer bld_test' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'a1b2c3d4' }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('UUID');
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
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
    mockMissionsFindFirst.mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', teamId: 'team-other', workspaceId: 'ws-1' });

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
    mockMissionsFindFirst.mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', teamId: 'team-1', workspaceId: 'ws-1' });

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
    expect(insertedArtifactValues.missionId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(insertedArtifactValues.workspaceId).toBe('ws-1');
  });

  // C16: the mission route accepted 8 of the 17 shared types. `screenshot` and
  // `impl_plan` are in the vocabulary and in the MCP help text, and were 400'd here.
  it.each(['screenshot', 'impl_plan', 'diff', 'alert'])(
    'accepts shared-vocabulary type %s',
    async (type) => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
      mockMissionsFindFirst.mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', teamId: 'team-1', workspaceId: 'ws-1' });

      const req = createRequest({
        method: 'POST',
        body: { type, title: 'Deliverable' },
        headers: { authorization: 'Bearer bld_test' },
      });
      const res = await POST(req, { params: mockParams });
      expect(res.status).toBe(200);
    },
  );

  it('rejects invalid artifact type', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', teamId: 'team-1', workspaceId: null });

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
    mockMissionsFindFirst.mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', teamId: 'team-1', workspaceId: null });

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
    mockMissionsFindFirst.mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', teamId: 'team-1', workspaceId: null });

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
    mockMissionsFindFirst.mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      method: 'POST',
      body: { type: 'summary', title: 'Session Artifact', content: 'test' },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(200);
  });

  it('does not notify on upsert when content and title are unchanged', async () => {
    const mockShouldNotifyOnArtifact = mock(async () => true);
    const mockNotifyArtifactReady = mock(async () => {});

    mock.module('@/lib/artifact-notify', () => ({
      shouldNotifyOnArtifact: mockShouldNotifyOnArtifact,
      notifyArtifactReady: mockNotifyArtifactReady,
    }));

    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      teamId: 'team-1',
      workspaceId: 'ws-1',
    });

    const existing = {
      id: 'artifact-1',
      content: 'Same content',
      title: 'Same title',
      shareToken: 'test-token',
    };
    mockArtifactsFindFirst.mockResolvedValue(existing);
    mockArtifactsUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [existing]),
        })),
      })),
    });

    const req = createRequest({
      method: 'POST',
      body: {
        type: 'report',
        title: 'Same title',
        content: 'Same content',
        key: 'my-artifact',
        taskId: 'task-1',
      },
      headers: { authorization: 'Bearer bld_test' },
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    // notifyArtifactReady should NOT be called because content/title unchanged
    expect(mockNotifyArtifactReady).not.toHaveBeenCalled();
  });

  it('notifies on upsert when content changed', async () => {
    const mockShouldNotifyOnArtifact = mock(async () => true);
    const mockNotifyArtifactReady = mock(async () => {});

    mock.module('@/lib/artifact-notify', () => ({
      shouldNotifyOnArtifact: mockShouldNotifyOnArtifact,
      notifyArtifactReady: mockNotifyArtifactReady,
    }));

    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      teamId: 'team-1',
      workspaceId: 'ws-1',
    });

    const existing = {
      id: 'artifact-1',
      content: 'Old content',
      title: 'Same title',
      shareToken: 'test-token',
    };
    mockArtifactsFindFirst.mockResolvedValue(existing);
    mockArtifactsUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ ...existing, content: 'New content' }]),
        })),
      })),
    });

    const req = createRequest({
      method: 'POST',
      body: {
        type: 'report',
        title: 'Same title',
        content: 'New content',
        key: 'my-artifact',
        taskId: 'task-1',
      },
      headers: { authorization: 'Bearer bld_test' },
    });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(mockNotifyArtifactReady).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/missions/[id]/artifacts', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReset();
    mockTeamMembersFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockArtifactsFindMany.mockReset();

    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);
  });

  it('returns 401 when not authenticated', async () => {
    const req = createRequest();
    const res = await GET(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('404s a non-UUID id (e.g. a short 8-hex id) without querying the db', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
    const req = createRequest({ headers: { authorization: 'Bearer bld_test' } });
    const res = await GET(req, { params: Promise.resolve({ id: 'a1b2c3d4' }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('UUID');
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
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
    mockMissionsFindFirst.mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', teamId: 'team-1' });
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

  describe('?types, ?limit and ?preview (the visual-review evidence read)', () => {
    const auth = () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1' });
      mockMissionsFindFirst.mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', teamId: 'team-1' });
    };
    const get = (query: string) => GET(createRequest({ headers: { authorization: 'Bearer bld_test' }, query }), { params: mockParams });

    it('no params: the unfiltered list, as before (no type predicate, no limit, content selected)', async () => {
      auth();
      mockArtifactsFindMany.mockResolvedValue([{ id: 'art-1', type: 'diff', title: 'D', content: 'x'.repeat(5000) }]);
      const res = await get('');
      const data = await res.json();
      const args = (mockArtifactsFindMany.mock.calls[0] as any[])[0];
      expect(args.limit).toBeUndefined();
      expect(args.columns).toBeUndefined();
      expect(JSON.stringify(args.where)).not.toContain('inArray');
      expect(data.artifacts[0].content).toHaveLength(5000);
    });

    it('types filters in SQL, and a diff the db returns anyway is never in the response', async () => {
      auth();
      mockArtifactsFindMany.mockResolvedValue([
        { id: 'art-shot', type: 'screenshot', title: 'Phone' },
        { id: 'art-diff', type: 'diff', title: 'A diff', content: 'secret diff body' },
        { id: 'art-rep', type: 'report', title: 'Visual validation', content: 'Verdict: pass' },
      ]);
      const res = await get('types=screenshot,report');
      expect(res.status).toBe(200);
      const data = await res.json();
      const args = (mockArtifactsFindMany.mock.calls[0] as any[])[0];
      expect(JSON.stringify(args.where)).toContain('"type":"inArray"');
      expect(JSON.stringify(args.where)).toContain('["screenshot","report"]');
      expect(data.artifacts.map((a: any) => a.id)).toEqual(['art-shot', 'art-rep']);
      expect(JSON.stringify(data)).not.toContain('secret diff body');
    });

    it('an unknown type is a 400, not a silent empty list', async () => {
      auth();
      const res = await get('types=screenshot,bogus');
      expect(res.status).toBe(400);
      expect(mockArtifactsFindMany).not.toHaveBeenCalled();
    });

    it('limit bounds the rows newest first, clamped to 200', async () => {
      auth();
      mockArtifactsFindMany.mockResolvedValue([]);
      await get('types=report&limit=100');
      let args = (mockArtifactsFindMany.mock.calls[0] as any[])[0];
      expect(args.limit).toBe(100);
      expect(JSON.stringify(args.orderBy)).toContain('desc');
      await get('types=report&limit=100000');
      args = (mockArtifactsFindMany.mock.calls[1] as any[])[0];
      expect(args.limit).toBe(200);
      await get('limit=nope');
      expect((await get('limit=nope')).status).toBe(400);
    });

    it('preview=1 does not select the full body and returns at most 2KB of it', async () => {
      auth();
      mockArtifactsFindMany.mockResolvedValue([
        { id: 'art-rep', type: 'report', title: 'Visual validation', contentPreview: 'y'.repeat(2048) },
        { id: 'art-shot', type: 'screenshot', title: 'Phone', contentPreview: null },
      ]);
      const res = await get('types=screenshot,report&preview=1');
      const data = await res.json();
      const args = (mockArtifactsFindMany.mock.calls[0] as any[])[0];
      expect(args.columns).toEqual({ content: false });
      expect(JSON.stringify(args.extras)).toContain('2048');
      expect(data.artifacts[0].content).toHaveLength(2048);
      expect(data.artifacts[0].contentPreview).toBeUndefined();
      expect(data.artifacts[1].content).toBeNull();
    });
  });
});
