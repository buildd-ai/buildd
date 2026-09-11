import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const mockAuthenticateApiKey = mock(async () => ({ teamId: 'team-1' }) as Row | null);
const mockGetTeamWorkspaceIds = mock(async () => ['11111111-1111-1111-1111-111111111111']);
const mockResolveWorkerByPrNumber = mock(async () => ({ status: 404, error: 'PR not found' }) as Row);

const mockExplainTask = mock(async () => ({ scope: 'task', subjects: [] }) as Row | null);
const mockExplainMission = mock(async () => ({ scope: 'mission', subjects: [] }) as Row | null);
const mockExplainWorkspace = mock(async () => ({ scope: 'workspace', subjects: [], considered: 0, quiet: 0 }) as Row);
const mockExplainPr = mock(async () => ({ scope: 'pr', subjects: [] }) as Row | null);

const mockTasksFindFirst = mock(async () => ({ id: 'task', workspaceId: '11111111-1111-1111-1111-111111111111' }) as Row | undefined);
const mockMissionsFindFirst = mock(async () => ({ id: 'mission', workspaceId: '11111111-1111-1111-1111-111111111111' }) as Row | undefined);
const mockWorkspacesFindFirst = mock(async () => ({ id: '11111111-1111-1111-1111-111111111111', teamId: 'team-1' }) as Row | undefined);

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ getTeamWorkspaceIds: mockGetTeamWorkspaceIds }));
mock.module('@/lib/pr-resolve', () => ({ resolveWorkerByPrNumber: mockResolveWorkerByPrNumber }));
mock.module('@/lib/explain', () => ({
  explainTask: mockExplainTask,
  explainMission: mockExplainMission,
  explainWorkspace: mockExplainWorkspace,
  explainPr: mockExplainPr,
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      missions: { findFirst: mockMissionsFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id' },
  tasks: { id: 'id' },
  workspaces: { id: 'id' },
}));
mock.module('drizzle-orm', () => ({ eq: (field: string, value: unknown) => ({ field, value }) }));

import { GET } from './route';

const WS = '11111111-1111-1111-1111-111111111111';
const TASK = '22222222-2222-2222-2222-222222222222';
const MISSION = '33333333-3333-3333-3333-333333333333';

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/explain?${query}`, {
    headers: new Headers({ authorization: 'Bearer bld_test' }),
  });
}

beforeEach(() => {
  mockAuthenticateApiKey.mockClear();
  mockExplainTask.mockClear();
  mockExplainMission.mockClear();
  mockExplainWorkspace.mockClear();
  mockExplainPr.mockClear();
  mockResolveWorkerByPrNumber.mockClear();
  mockAuthenticateApiKey.mockImplementation(async () => ({ teamId: 'team-1' }));
  mockTasksFindFirst.mockImplementation(async () => ({ id: TASK, workspaceId: WS }));
  mockMissionsFindFirst.mockImplementation(async () => ({ id: MISSION, workspaceId: WS }));
  mockWorkspacesFindFirst.mockImplementation(async () => ({ id: WS, teamId: 'team-1' }));
});

describe('GET /api/explain — subject selection', () => {
  it('rejects a call with no subject', async () => {
    const res = await GET(req(''));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('exactly one');
  });

  it('rejects two subjects rather than guessing which was meant', async () => {
    const res = await GET(req(`taskId=${TASK}&missionId=${MISSION}`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('taskId');
    expect(body.error).toContain('missionId');
    expect(mockExplainTask).not.toHaveBeenCalled();
    expect(mockExplainMission).not.toHaveBeenCalled();
  });

  it('treats workspaceId alongside prNumber as a disambiguator, not a second subject', async () => {
    mockResolveWorkerByPrNumber.mockImplementation(async () => ({
      id: 'w', taskId: 't', workspaceId: WS, prNumber: 7, status: 'completed',
    }));
    const res = await GET(req(`prNumber=7&workspaceId=${WS}`));
    expect(res.status).toBe(200);
    expect(mockExplainPr).toHaveBeenCalledTimes(1);
    expect(mockExplainWorkspace).not.toHaveBeenCalled();
    // The disambiguator is handed to the shared resolver, not re-implemented.
    expect(mockResolveWorkerByPrNumber.mock.calls[0][2]).toBe(WS);
  });

  it('requires authentication', async () => {
    mockAuthenticateApiKey.mockImplementation(async () => null);
    const res = await GET(req(`missionId=${MISSION}`));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/explain — scoping', () => {
  it('404s a task in another team rather than explaining it', async () => {
    mockTasksFindFirst.mockImplementation(async () => ({ id: TASK, workspaceId: 'other-ws' }));
    const res = await GET(req(`taskId=${TASK}`));
    expect(res.status).toBe(404);
    expect(mockExplainTask).not.toHaveBeenCalled();
  });

  it('404s a mission in another team', async () => {
    mockMissionsFindFirst.mockImplementation(async () => ({ id: MISSION, workspaceId: 'other-ws' }));
    const res = await GET(req(`missionId=${MISSION}`));
    expect(res.status).toBe(404);
    expect(mockExplainMission).not.toHaveBeenCalled();
  });

  it('404s a workspace outside the caller team', async () => {
    mockWorkspacesFindFirst.mockImplementation(async () => ({ id: WS, teamId: 'other-team' }));
    const res = await GET(req(`workspaceId=${WS}`));
    expect(res.status).toBe(404);
    expect(mockExplainWorkspace).not.toHaveBeenCalled();
  });

  it('rejects an id that is not a UUID before touching the database', async () => {
    const res = await GET(req('taskId=abc12345'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('UUID');
  });

  it('propagates the resolver\'s 409 when a PR number is ambiguous', async () => {
    mockResolveWorkerByPrNumber.mockImplementation(async () => ({
      status: 409,
      error: 'PR #7 exists in multiple workspaces — pass workspaceId to disambiguate',
      candidates: ['ws-a', 'ws-b'],
    }));
    const res = await GET(req('prNumber=7'));
    expect(res.status).toBe(409);
    expect((await res.json()).candidates).toEqual(['ws-a', 'ws-b']);
  });
});

describe('GET /api/explain — happy paths', () => {
  it('explains a task', async () => {
    mockExplainTask.mockImplementation(async () => ({ scope: 'task', subjects: [{ state: 'idle' }] }));
    const res = await GET(req(`taskId=${TASK}`));
    expect(res.status).toBe(200);
    expect((await res.json()).scope).toBe('task');
  });

  it('explains a mission', async () => {
    mockExplainMission.mockImplementation(async () => ({ scope: 'mission', subjects: [{ state: 'blocked' }] }));
    const res = await GET(req(`missionId=${MISSION}`));
    expect(res.status).toBe(200);
    expect((await res.json()).scope).toBe('mission');
  });

  it('explains a workspace', async () => {
    const res = await GET(req(`workspaceId=${WS}`));
    expect(res.status).toBe(200);
    expect((await res.json()).scope).toBe('workspace');
  });

  it('404s a PR whose worker has no task attached', async () => {
    mockResolveWorkerByPrNumber.mockImplementation(async () => ({
      id: 'w', taskId: null, workspaceId: WS, prNumber: 7, status: 'completed',
    }));
    mockExplainPr.mockImplementation(async () => null);
    const res = await GET(req('prNumber=7'));
    expect(res.status).toBe(404);
  });
});
