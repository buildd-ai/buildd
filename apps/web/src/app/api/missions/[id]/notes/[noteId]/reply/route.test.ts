import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockMissionsFindFirst = mock(() => null as any);
const mockNotesFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockTriggerEvent = mock(() => Promise.resolve());

const mockInsertValues = mock((vals: any) => ({ returning: () => [{ id: 'reply-1', ...vals }] }));
const mockUpdate = mock(() => ({ set: () => ({ where: () => Promise.resolve() }) }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: mockResolveAccountTeamIds }));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { task: (id: string) => `task-${id}`, mission: (id: string) => `mission-${id}` },
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
      missionNotes: { findFirst: mockNotesFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: () => ({ values: mockInsertValues }),
    update: () => mockUpdate(),
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'missions.id' },
  missionNotes: { id: 'missionNotes.id', missionId: 'missionNotes.missionId' },
  workspaces: { id: 'workspaces.id' },
}));

import { POST } from './route';

const params = Promise.resolve({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', noteId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });

function createRequest(body: any): NextRequest {
  return new NextRequest('http://localhost:3000/api/missions/dddddddd-dddd-4ddd-8ddd-dddddddddddd/notes/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/reply', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

describe('POST /api/missions/[id]/notes/[noteId]/reply', () => {
  beforeEach(() => {
    mockTriggerEvent.mockClear();
    mockInsertValues.mockClear();
    mockWakeMissionAfterResponse.mockClear();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', teamId: 'team-1', workspaceId: null });
    mockNotesFindFirst.mockResolvedValue({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', missionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', taskId: null, type: 'question' });
  });

  it('404s a non-UUID mission id without querying the db', async () => {
    const res = await POST(createRequest({ title: 'Ship it' }), { params: Promise.resolve({ id: 'a1b2c3d4', noteId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('UUID');
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
  });

  it('404s a non-UUID note id without querying the db', async () => {
    const res = await POST(createRequest({ title: 'Ship it' }), { params: Promise.resolve({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', noteId: 'a1b2c3d4' }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('UUID');
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
  });

  it('announces the reply on the mission channel', async () => {
    const res = await POST(createRequest({ title: 'Ship it' }), { params });
    expect(res.status).toBe(201);
    expect(mockTriggerEvent.mock.calls.map((c: any[]) => c[0])).toEqual(['mission-dddddddd-dddd-4ddd-8ddd-dddddddddddd']);
  });

  // S6: a task page open on the question's task listens on the task channel only.
  it('also announces it on the task channel when the question is pinned to a task', async () => {
    mockNotesFindFirst.mockResolvedValue({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', missionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', taskId: 'task-7', type: 'question' });

    await POST(createRequest({ title: 'Ship it' }), { params });

    expect(mockTriggerEvent.mock.calls.map((c: any[]) => c[0])).toEqual(['mission-dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'task-task-7']);
  });

  // An owner answering a question the organizer asked wakes the mission.
  it('wakes the mission with owner_answer when a signed-in user replies', async () => {
    await POST(createRequest({ title: 'Use Redis' }), { params });
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledTimes(1);
    expect(mockWakeMissionAfterResponse).toHaveBeenCalledWith('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'owner_answer');
  });

  it('does not wake on an API-key (agent) reply', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    const res = await POST(createRequest({ title: 'Agent reply' }), { params });
    expect(res.status).toBe(201);
    expect(mockWakeMissionAfterResponse).not.toHaveBeenCalled();
  });
});
