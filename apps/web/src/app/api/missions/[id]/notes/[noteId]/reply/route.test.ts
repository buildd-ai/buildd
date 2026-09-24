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

const params = Promise.resolve({ id: 'mission-1', noteId: 'note-1' });

function createRequest(body: any): NextRequest {
  return new NextRequest('http://localhost:3000/api/missions/mission-1/notes/note-1/reply', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

describe('POST /api/missions/[id]/notes/[noteId]/reply', () => {
  beforeEach(() => {
    mockTriggerEvent.mockClear();
    mockInsertValues.mockClear();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'mission-1', teamId: 'team-1', workspaceId: null });
    mockNotesFindFirst.mockResolvedValue({ id: 'note-1', missionId: 'mission-1', taskId: null, type: 'question' });
  });

  it('announces the reply on the mission channel', async () => {
    const res = await POST(createRequest({ title: 'Ship it' }), { params });
    expect(res.status).toBe(201);
    expect(mockTriggerEvent.mock.calls.map((c: any[]) => c[0])).toEqual(['mission-mission-1']);
  });

  // S6: a task page open on the question's task listens on the task channel only.
  it('also announces it on the task channel when the question is pinned to a task', async () => {
    mockNotesFindFirst.mockResolvedValue({ id: 'note-1', missionId: 'mission-1', taskId: 'task-7', type: 'question' });

    await POST(createRequest({ title: 'Ship it' }), { params });

    expect(mockTriggerEvent.mock.calls.map((c: any[]) => c[0])).toEqual(['mission-mission-1', 'task-task-7']);
  });
});
