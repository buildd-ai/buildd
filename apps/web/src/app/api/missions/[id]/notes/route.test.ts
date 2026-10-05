import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockMissionsFindFirst = mock(() => null as any);
const mockMissionNotesFindFirst = mock(() => null as any);
const mockMissionNotesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);

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
  resolveAccountTeamIds: mockResolveAccountTeamIds,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { mission: (id: string) => `mission-${id}`, task: (id: string) => `task-${id}` },
  events: { MISSION_NOTE_POSTED: 'mission:note_posted' },
}));

// wakeMission's own gating is covered in lib/mission-wake.test.ts.
const mockWakeMissionAfterResponse = mock((_id: string, _reason: string) => {});
mock.module('@/lib/mission-wake', () => ({
  wakeMission: mock(() => Promise.resolve({ woken: false, reason: 'not_found' })),
  wakeMissionAfterResponse: mockWakeMissionAfterResponse,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      missionNotes: { findFirst: mockMissionNotesFindFirst, findMany: mockMissionNotesFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findFirst: mockWorkersFindFirst },
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
  accounts: { id: 'id' },
}));

import { GET, POST } from './route';

const MISSION_ID = '11111111-1111-4111-8111-111111111111';
const mockParams = Promise.resolve({ id: MISSION_ID });
const nonUuidParams = Promise.resolve({ id: 'mission-1' });

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
  return new NextRequest(url || `http://localhost:3000/api/missions/${MISSION_ID}/notes`, init);
}

describe('GET /api/missions/[id]/notes', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReset();
    mockMissionNotesFindMany.mockReset();
    mockMissionNotesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();

    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);
  });

  it('returns 401 when not authenticated', async () => {
    const req = createRequest();
    const res = await GET(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('rejects a non-UUID mission id (e.g. a short 8-hex id) without querying the db', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });

    const req = createRequest({ headers: { authorization: 'Bearer bld_test' } });
    const res = await GET(req, { params: nonUuidParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID cursor', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    mockMissionsFindFirst.mockResolvedValue({ id: MISSION_ID, teamId: 'team-1', workspaceId: null });

    const req = createRequest({
      headers: { authorization: 'Bearer bld_test' },
      url: `http://localhost:3000/api/missions/${MISSION_ID}/notes?cursor=note-1`,
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(mockMissionNotesFindFirst).not.toHaveBeenCalled();
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
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReset();
    mockTriggerEvent.mockReset();
    mockInsert.mockReset();
    mockUpdate.mockReset();
    insertedNoteValues = null;
    updatedNoteValues = null;
    mockWakeMissionAfterResponse.mockClear();

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

  it('rejects a non-UUID mission id without querying the db', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);

    const req = createRequest({
      method: 'POST',
      body: { type: 'question', title: 'Test?' },
    });
    const res = await POST(req, { params: nonUuidParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
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

  // S6: the task page's question feed listens on the task channel only, so a
  // mission question pinned to a task must also be announced there.
  it('also announces a task-pinned note on that task channel', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });

    await POST(createRequest({
      method: 'POST',
      body: { type: 'question', title: 'Which queue?', taskId: 'task-7' },
    }), { params: mockParams });

    const channelsHit = mockTriggerEvent.mock.calls.map((c: any[]) => c[0]);
    expect(channelsHit).toEqual([`mission-${MISSION_ID}`, 'task-task-7']);
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

  // ── Wake on an owner note (event-driven replanning §2) ────────────────────
  function asUser() {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: MISSION_ID, teamId: 'team-1', workspaceId: null });
  }

  it('wakes the mission with owner_note when a signed-in user posts a note', async () => {
    asUser();
    await POST(createRequest({ method: 'POST', body: { type: 'guidance', title: 'Prioritise the API' } }), { params: mockParams });
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledTimes(1);
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledWith(MISSION_ID, 'owner_note');
  });

  it('wakes with owner_answer when the user note replies to another note', async () => {
    asUser();
    await POST(createRequest({ method: 'POST', body: { type: 'reply', title: 'Yes, use Redis', replyTo: 'note-parent' } }), { params: mockParams });
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledWith(MISSION_ID, 'owner_answer');
  });

  it('does not wake on an agent note', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    mockMissionsFindFirst.mockResolvedValue({ id: MISSION_ID, teamId: 'team-1', workspaceId: null });
    await POST(createRequest({
      method: 'POST',
      body: { type: 'decision', title: 'Chose Redis' },
      headers: { authorization: 'Bearer bld_test' },
    }), { params: mockParams });
    expect(mockWakeMissionAfterResponse).not.toHaveBeenCalled();
  });

  it('does not wake when an API-key caller claims authorType=user', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    mockMissionsFindFirst.mockResolvedValue({ id: MISSION_ID, teamId: 'team-1', workspaceId: null });
    await POST(createRequest({
      method: 'POST',
      body: { type: 'guidance', title: 'Impersonating', authorType: 'user' },
      headers: { authorization: 'Bearer bld_test' },
    }), { params: mockParams });
    expect(mockWakeMissionAfterResponse).not.toHaveBeenCalled();
  });

  it('does not wake on a system note posted by a signed-in user', async () => {
    asUser();
    await POST(createRequest({ method: 'POST', body: { type: 'update', title: 'Sync', authorType: 'system' } }), { params: mockParams });
    expect(mockWakeMissionAfterResponse).not.toHaveBeenCalled();
  });
});

describe('POST /api/missions/[id]/notes — per-task token', () => {
  const OWN_TASK = '22222222-2222-4222-8222-222222222222';
  const SCOPED = { id: 'acct-1', teamId: 'team-1', level: 'worker', scopes: null, taskScope: { taskId: OWN_TASK, workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };
  const post = (body: Record<string, unknown>, missionId = MISSION_ID) =>
    POST(createRequest({ method: 'POST', body, headers: { authorization: 'Bearer bld_test' }, url: `http://localhost:3000/api/missions/${missionId}/notes` }), { params: Promise.resolve({ id: missionId }) });

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReset();
    mockMissionsFindFirst.mockResolvedValue({ id: MISSION_ID, teamId: 'team-1', workspaceId: 'ws-1' });
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue({ missionId: MISSION_ID, workspaceId: 'ws-1', mission: { initiativeId: null } });
    mockWorkersFindFirst.mockReset();
    mockWorkersFindFirst.mockResolvedValue({ taskId: OWN_TASK, accountId: 'acct-1' });
    mockInsert.mockReset();
    insertedNoteValues = null;
    mockInsert.mockReturnValue({
      values: mock((vals: any) => {
        insertedNoteValues = vals;
        return { returning: mock(() => [{ id: 'note-1', ...vals, createdAt: new Date() }]) };
      }),
    });
  });

  it("posts to its own task's mission feed, pinned to its own task and worker", async () => {
    mockAuthenticateApiKey.mockResolvedValue(SCOPED);
    const res = await post({ type: 'question', title: 'Which?', taskId: OWN_TASK, workerId: 'worker-own' });
    expect(res.status).toBe(201);
    expect(insertedNoteValues.missionId).toBe(MISSION_ID);
    expect(insertedNoteValues.taskId).toBe(OWN_TASK);
  });

  it('is refused another mission, before the mission is read or anything written', async () => {
    mockAuthenticateApiKey.mockResolvedValue(SCOPED);
    const other = '33333333-3333-4333-8333-333333333333';
    const res = await post({ type: 'update', title: 'Elsewhere' }, other);
    expect(res.status).toBe(404);
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
    expect(insertedNoteValues).toBeNull();
  });

  it('is refused a note pinned to another task', async () => {
    mockAuthenticateApiKey.mockResolvedValue(SCOPED);
    const res = await post({ type: 'update', title: 'Pinned', taskId: '44444444-4444-4444-8444-444444444444' });
    expect(res.status).toBe(403);
    expect(insertedNoteValues).toBeNull();
  });

  it("is refused a note attributed to another task's worker", async () => {
    mockAuthenticateApiKey.mockResolvedValue(SCOPED);
    mockWorkersFindFirst.mockResolvedValue({ taskId: '44444444-4444-4444-8444-444444444444', accountId: 'acct-1' });
    const res = await post({ type: 'question', title: 'Which?', workerId: 'worker-other' });
    expect(res.status).toBe(403);
    expect(insertedNoteValues).toBeNull();
  });

  it("stores a task token's note as agent-authored, with the default status, whatever the body claims", async () => {
    mockAuthenticateApiKey.mockResolvedValue(SCOPED);
    const res = await post({ type: 'question', title: 'Which?', authorType: 'user', status: 'answered' });
    expect(res.status).toBe(201);
    expect(insertedNoteValues.authorType).toBe('agent');
    expect(insertedNoteValues.status).toBe('open');
    expect(mockWakeMissionAfterResponse).not.toHaveBeenCalled();
  });

  for (const type of ['guidance', 'reply'] as const) {
    it(`refuses a task token a ${type} note, before writing`, async () => {
      mockAuthenticateApiKey.mockResolvedValue(SCOPED);
      const res = await post({ type, title: 'Do it this way' });
      expect(res.status).toBe(403);
      expect(insertedNoteValues).toBeNull();
    });
  }

  it('refuses a task token answering a question via replyTo, before marking anything answered', async () => {
    mockAuthenticateApiKey.mockResolvedValue(SCOPED);
    mockUpdate.mockClear();
    const res = await post({ type: 'update', title: 'Answered', replyTo: '55555555-5555-4555-8555-555555555555' });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(insertedNoteValues).toBeNull();
  });

  it("an admin account key's authorType, status, guidance and replies are honoured as before", async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'admin', scopes: null });
    const res = await post({ type: 'guidance', title: 'Steer', authorType: 'user', status: 'dismissed' });
    expect(res.status).toBe(201);
    expect(insertedNoteValues.authorType).toBe('user');
    expect(insertedNoteValues.status).toBe('dismissed');
  });

  it('a worker-level account key is still refused by the admin gate', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'worker', scopes: null });
    const res = await post({ type: 'update', title: 'Progress' });
    expect(res.status).toBe(401);
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
    expect(insertedNoteValues).toBeNull();
  });
});
