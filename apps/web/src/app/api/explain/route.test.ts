import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const mockAuthenticateApiKey = mock(async () => ({ id: 'acct-1', teamId: 'team-1' }) as Row | null);
// The access predicate itself is stubbed, never the rows it would read.
const mockVerifyAccountWorkspaceAccess = mock(async (_accountId: string, _ws: string) => true);
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
const mockGetCurrentUser = mock(async () => null as Row | null);
const mockGetUserTeamIds = mock(async (_userId: string) => [] as string[]);
const mockResolveWorkerByPrNumberInWorkspaces = mock(async () => ({ status: 404, error: 'PR not found' }) as Row);
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({
  getTeamWorkspaceIds: mockGetTeamWorkspaceIds,
  getUserTeamIds: mockGetUserTeamIds,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@/lib/pr-resolve', () => ({
  resolveWorkerByPrNumber: mockResolveWorkerByPrNumber,
  resolveWorkerByPrNumberInWorkspaces: mockResolveWorkerByPrNumberInWorkspaces,
}));
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
  mockGetCurrentUser.mockReset();
  mockGetCurrentUser.mockImplementation(async () => null);
  mockGetUserTeamIds.mockReset();
  mockGetUserTeamIds.mockImplementation(async () => []);
  mockGetTeamWorkspaceIds.mockReset();
  mockGetTeamWorkspaceIds.mockImplementation(async () => [WS]);
  mockResolveWorkerByPrNumberInWorkspaces.mockReset();
  mockResolveWorkerByPrNumberInWorkspaces.mockImplementation(async () => ({ status: 404, error: 'PR not found' }));
  mockAuthenticateApiKey.mockClear();
  mockExplainTask.mockClear();
  mockExplainMission.mockClear();
  mockExplainWorkspace.mockClear();
  mockExplainPr.mockClear();
  mockResolveWorkerByPrNumber.mockClear();
  mockAuthenticateApiKey.mockImplementation(async () => ({ id: 'acct-1', teamId: 'team-1' }));
  mockVerifyAccountWorkspaceAccess.mockReset();
  mockVerifyAccountWorkspaceAccess.mockImplementation(async () => true);
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
    mockMissionsFindFirst.mockImplementation(async () => ({ id: MISSION, workspaceId: 'other-ws', teamId: 'other-team' }));
    const res = await GET(req(`missionId=${MISSION}`));
    expect(res.status).toBe(404);
    expect(mockExplainMission).not.toHaveBeenCalled();
  });

  it('explains a team-level mission (workspaceId NULL, teamId matches)', async () => {
    mockMissionsFindFirst.mockImplementation(async () => ({ id: MISSION, workspaceId: null, teamId: 'team-1' }));
    mockExplainMission.mockImplementation(async () => ({ scope: 'mission', subjects: [{ state: 'active' }] }));
    const res = await GET(req(`missionId=${MISSION}`));
    expect(res.status).toBe(200);
    expect((await res.json()).scope).toBe('mission');
    expect(mockExplainMission).toHaveBeenCalledTimes(1);
  });

  it('404s a team-level mission in another team', async () => {
    mockMissionsFindFirst.mockImplementation(async () => ({ id: MISSION, workspaceId: null, teamId: 'other-team' }));
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

describe('GET /api/explain — restricted workspace (API key with no link)', () => {
  beforeEach(() => {
    // Same team, but the workspace is restricted and this account is not linked.
    mockVerifyAccountWorkspaceAccess.mockImplementation(async () => false);
  });

  it('404s a task there, as GET /api/tasks/[id] does, and never builds its evidence list', async () => {
    const res = await GET(req(`taskId=${TASK}`));
    expect(res.status).toBe(404);
    expect(mockVerifyAccountWorkspaceAccess).toHaveBeenCalledWith('acct-1', WS);
    expect(mockExplainTask).not.toHaveBeenCalled();
  });

  it('404s a PR whose task lives there', async () => {
    mockResolveWorkerByPrNumber.mockImplementation(async () => ({
      id: 'w', taskId: 't', workspaceId: WS, prNumber: 7, status: 'completed',
    }));
    const res = await GET(req('prNumber=7'));
    expect(res.status).toBe(404);
    expect(mockExplainPr).not.toHaveBeenCalled();
  });

  it('404s the workspace itself', async () => {
    const res = await GET(req(`workspaceId=${WS}`));
    expect(res.status).toBe(404);
    expect(mockExplainWorkspace).not.toHaveBeenCalled();
  });

  it('hands the account to the explainer so the inline evidence list is audited to it', async () => {
    mockVerifyAccountWorkspaceAccess.mockImplementation(async () => true);
    await GET(req(`taskId=${TASK}`));
    expect(mockExplainTask.mock.calls[0] as unknown[]).toEqual([TASK, { accountId: 'acct-1' }]);
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

describe('GET /api/explain — dashboard session', () => {
  const WS_B = '44444444-4444-4444-4444-444444444444';

  function sessionReq(query: string): NextRequest {
    return new NextRequest(`http://localhost:3000/api/explain?${query}`);
  }

  beforeEach(() => {
    mockAuthenticateApiKey.mockImplementation(async () => null);
    mockGetCurrentUser.mockImplementation(async () => ({ id: 'user-1' }));
    // The user is in two teams; team-1 owns WS, team-2 owns WS_B.
    mockGetUserTeamIds.mockImplementation(async () => ['team-1', 'team-2']);
    mockGetTeamWorkspaceIds.mockImplementation(async (teamId: string) => (teamId === 'team-1' ? [WS] : [WS_B]));
    mockExplainPr.mockImplementation(async () => ({ scope: 'pr', subjects: [] }));
  });

  it('explains a task in one of the user teams', async () => {
    const res = await GET(sessionReq(`taskId=${TASK}`));
    expect(res.status).toBe(200);
    expect(mockGetUserTeamIds).toHaveBeenCalledWith('user-1');
    expect(mockExplainTask).toHaveBeenCalledTimes(1);
    // A session is decided by team membership, as on GET /api/tasks/[id].
    expect(mockVerifyAccountWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockExplainTask.mock.calls[0] as unknown[]).toEqual([TASK, { userId: 'user-1' }]);
  });

  it('explains a workspace owned by any of the user teams', async () => {
    mockWorkspacesFindFirst.mockImplementation(async () => ({ id: WS_B, teamId: 'team-2' }));
    const res = await GET(sessionReq(`workspaceId=${WS_B}`));
    expect(res.status).toBe(200);
  });

  it('404s a task outside every team the user belongs to', async () => {
    mockTasksFindFirst.mockImplementation(async () => ({ id: TASK, workspaceId: 'other-ws' }));
    const res = await GET(sessionReq(`taskId=${TASK}`));
    expect(res.status).toBe(404);
    expect(mockExplainTask).not.toHaveBeenCalled();
  });

  it('explains a team-level mission via session', async () => {
    mockMissionsFindFirst.mockImplementation(async () => ({ id: MISSION, workspaceId: null, teamId: 'team-1' }));
    mockExplainMission.mockImplementation(async () => ({ scope: 'mission', subjects: [{ state: 'active' }] }));
    const res = await GET(sessionReq(`missionId=${MISSION}`));
    expect(res.status).toBe(200);
    expect((await res.json()).scope).toBe('mission');
    expect(mockExplainMission).toHaveBeenCalledTimes(1);
  });

  it('404s a team-level mission in another team via session', async () => {
    mockMissionsFindFirst.mockImplementation(async () => ({ id: MISSION, workspaceId: null, teamId: 'other-team' }));
    const res = await GET(sessionReq(`missionId=${MISSION}`));
    expect(res.status).toBe(404);
    expect(mockExplainMission).not.toHaveBeenCalled();
  });

  it('404s a workspace outside the user teams', async () => {
    mockWorkspacesFindFirst.mockImplementation(async () => ({ id: WS, teamId: 'other-team' }));
    const res = await GET(sessionReq(`workspaceId=${WS}`));
    expect(res.status).toBe(404);
    expect(mockExplainWorkspace).not.toHaveBeenCalled();
  });

  it('resolves a PR number across the user workspaces with the shared resolver', async () => {
    mockResolveWorkerByPrNumberInWorkspaces.mockImplementation(async () => ({
      id: 'w', taskId: 't', workspaceId: WS, prNumber: 7, status: 'completed',
    }));
    const res = await GET(sessionReq('prNumber=7'));
    expect(res.status).toBe(200);
    expect(mockResolveWorkerByPrNumber).not.toHaveBeenCalled();
    expect((mockResolveWorkerByPrNumberInWorkspaces.mock.calls[0] as unknown[])[0]).toEqual([WS, WS_B]);
  });

  describe('teamId pin', () => {
    it('limits results to the pinned team: a team-2 task is not visible under ?teamId=team-1', async () => {
      mockTasksFindFirst.mockImplementation(async () => ({ id: TASK, workspaceId: WS_B }));
      const res = await GET(sessionReq(`taskId=${TASK}&teamId=team-1`));
      expect(res.status).toBe(404);
      expect(mockExplainTask).not.toHaveBeenCalled();
    });

    it('limits a workspace subject to the pinned team', async () => {
      mockWorkspacesFindFirst.mockImplementation(async () => ({ id: WS_B, teamId: 'team-2' }));
      const res = await GET(sessionReq(`workspaceId=${WS_B}&teamId=team-1`));
      expect(res.status).toBe(404);
    });

    it('searches only the pinned team workspaces for a PR number', async () => {
      mockResolveWorkerByPrNumberInWorkspaces.mockImplementation(async () => ({
        id: 'w', taskId: 't', workspaceId: WS, prNumber: 7, status: 'completed',
      }));
      await GET(sessionReq('prNumber=7&teamId=team-1'));
      expect((mockResolveWorkerByPrNumberInWorkspaces.mock.calls[0] as unknown[])[0]).toEqual([WS]);
    });

    it('404s a pin to a team the user is not in', async () => {
      const res = await GET(sessionReq(`taskId=${TASK}&teamId=team-9`));
      expect(res.status).toBe(404);
      expect(mockExplainTask).not.toHaveBeenCalled();
    });
  });

  it('401s with neither a session nor a key', async () => {
    mockGetCurrentUser.mockImplementation(async () => null);
    const res = await GET(sessionReq(`taskId=${TASK}`));
    expect(res.status).toBe(401);
  });

  it('keeps a present key authoritative and ignores teamId on the key path', async () => {
    mockAuthenticateApiKey.mockImplementation(async () => ({ id: 'acct-1', teamId: 'team-1' }));
    const res = await GET(req(`taskId=${TASK}&teamId=team-9`));
    expect(res.status).toBe(200);
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
    expect(mockGetUserTeamIds).not.toHaveBeenCalled();
  });
});
