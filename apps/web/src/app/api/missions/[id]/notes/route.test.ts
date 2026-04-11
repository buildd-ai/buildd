import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockMissionsFindFirst = mock(() => null as any);
const mockMissionNotesFindFirst = mock(() => null as any);
const mockMissionNotesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);

let insertedNoteValues: any = null;
const mockInsert = mock(() => ({
  values: mock((vals: any) => {
    insertedNoteValues = vals;
    return {
      returning: mock(() => [{
        id: 'note-1',
        ...vals,
        createdAt: new Date(),
      }]),
    };
  }),
}));

let updatedNoteValues: any = null;
const mockUpdate = mock(() => ({
  set: mock((vals: any) => {
    updatedNoteValues = vals;
    return {
      where: mock(() => ({})),
    };
  }),
}));

const mockTriggerEvent = mock(() => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { mission: (id: string) => `mission-${id}` },
  events: { MISSION_NOTE_POSTED: 'mission:note_posted' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      missionNotes: { findFirst: mockMissionNotesFindFirst, findMany: mockMissionNotesFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: () => mockInsert(),
    update: () => mockUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => args,
  desc: (field: any) => ({ field, type: 'desc' }),
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id', teamId: 'teamId', workspaceId: 'workspaceId' },
  missionNotes: {
    id: 'id', missionId: 'missionId', type: 'type', status: 'status',
    createdAt: 'createdAt', authorType: 'authorType',
  },
  workspaces: { id: 'id', accessMode: 'accessMode' },
}));

import { GET, POST } from './route';

const mockParams = Promise.resolve({ id: 'mission-1' });

function createRequest(options: {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
  url?: string;
} = {}): NextRequest {
  const { method = 'GET', body, headers: extraHeaders, url } = options;
  const headers: Record<string, string> = { ...extraHeaders };
  if (body) headers['content-type'] = 'application/json';
  const init: RequestInit = { method, headers: new Headers(headers) };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(url || 'http://localhost:3000/api/missions/mission-1/notes', init);
}

describe('GET /api/missions/[id]/notes', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockMissionsFindFirst.mockReset();
    mockMissionNotesFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();

    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);
  });

  it('returns 401 when not authenticated', async () => {
    const req = createRequest();
    const res = await GET(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns 401 when mission not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    mockMissionsFindFirst.mockResolvedValue(null);

    const req = createRequest({ headers: { authorization: 'Bearer bld_test' } });
    const res = await GET(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('returns notes for a mission', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });
    mockMissionNotesFindMany.mockResolvedValue([
      { id: 'note-1', type: 'question', title: 'Redis vs Memcached?', status: 'open', createdAt: new Date() },
    ]);

    const req = createRequest({ headers: { authorization: 'Bearer bld_test' } });
    const res = await GET(req, { params: mockParams });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.notes).toHaveLength(1);
    expect(data.notes[0].title).toBe('Redis vs Memcached?');
    expect(data.hasMore).toBe(false);
  });

  it('works with session auth', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });
    mockMissionNotesFindMany.mockResolvedValue([]);

    const req = createRequest();
    const res = await GET(req, { params: mockParams });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.notes).toHaveLength(0);
  });
});

describe('POST /api/missions/[id]/notes', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockMissionsFindFirst.mockReset();
    mockTriggerEvent.mockReset();
    mockInsert.mockReset();
    mockUpdate.mockReset();
    insertedNoteValues = null;
    updatedNoteValues = null;

    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    mockInsert.mockReturnValue({
      values: mock((vals: any) => {
        insertedNoteValues = vals;
        return {
          returning: mock(() => [{
            id: 'note-1',
            ...vals,
            createdAt: new Date(),
          }]),
        };
      }),
    });

    mockUpdate.mockReturnValue({
      set: mock((vals: any) => {
        updatedNoteValues = vals;
        return {
          where: mock(() => ({})),
        };
      }),
    });
  });

  it('returns 401 when not authenticated', async () => {
    const req = createRequest({
      method: 'POST',
      body: { type: 'question', title: 'Test?' },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('rejects invalid note type', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      method: 'POST',
      body: { type: 'invalid', title: 'Bad' },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('requires title', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      method: 'POST',
      body: { type: 'question' },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(400);
  });

  it('creates a question note with open status', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      method: 'POST',
      body: {
        type: 'question',
        title: 'Redis vs Memcached?',
        bodyText: 'Redis adds a dep but persists across restarts',
        defaultChoice: 'Redis',
      },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(201);

    expect(insertedNoteValues).not.toBeNull();
    expect(insertedNoteValues.type).toBe('question');
    expect(insertedNoteValues.title).toBe('Redis vs Memcached?');
    expect(insertedNoteValues.defaultChoice).toBe('Redis');
    expect(insertedNoteValues.status).toBe('open');
    expect(insertedNoteValues.authorType).toBe('user');
  });

  it('creates a guidance note', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      method: 'POST',
      body: {
        type: 'guidance',
        title: 'Use Redis everywhere',
      },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(201);

    expect(insertedNoteValues.type).toBe('guidance');
    expect(insertedNoteValues.status).toBe('answered');
  });

  it('sets authorType to agent for API key auth', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      method: 'POST',
      body: { type: 'decision', title: 'Using Redis for caching', authorType: 'agent' },
      headers: { authorization: 'Bearer bld_test' },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(201);
    expect(insertedNoteValues.authorType).toBe('agent');
  });

  it('triggers Pusher event on note creation', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      method: 'POST',
      body: { type: 'update', title: 'Progress update' },
    });
    await POST(req, { params: mockParams });

    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
  });

  it('marks parent note as answered when replyTo is set', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      method: 'POST',
      body: {
        type: 'reply',
        title: 'Use Redis with ioredis',
        replyTo: 'note-parent',
      },
    });
    const res = await POST(req, { params: mockParams });
    expect(res.status).toBe(201);

    // Should have called update to mark parent as answered
    expect(updatedNoteValues).toEqual({ status: 'answered' });
  });
});
