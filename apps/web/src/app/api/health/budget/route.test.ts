import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

const mockGetBudgetForecast = mock(() =>
  Promise.resolve({
    oauthSessions: [],
    monthly: null,
    codex: null,
    missions: [],
  })
);
mock.module('@/lib/budget-forecast', () => ({
  getBudgetForecast: mockGetBudgetForecast,
}));

const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesFindMany = mock(() => [] as any[]);
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: {
        findFirst: mockWorkspacesFindFirst,
        findMany: mockWorkspacesFindMany,
      },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: 'workspaces',
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

const mockGetCurrentUser = mock(async () => null as any);
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));

// Session scope: user-1 belongs to TEAM_ID (owns VALID_UUID) and TEAM_B (owns WS_B).
const TEAM_B = 'team-b';
const WS_B = '00000000-0000-0000-0000-00000000000b';
const mockGetUserTeamIds = mock(async (_userId: string) => [] as string[]);
const mockGetTeamWorkspaceIds = mock(async (_teamId: string) => [] as string[]);
const mockResolveActiveTeamId = mock(async (_userId: string, _cookie: string | null | undefined) => null as string | null);
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getTeamWorkspaceIds: mockGetTeamWorkspaceIds,
  resolveActiveTeamId: mockResolveActiveTeamId,
}));

import { GET } from './route';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_UUID = '00000000-0000-0000-0000-000000000001';
const TEAM_ID = 'team-00000000-0000-0000-0000-000000000001';

function makeRequest(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers: new Headers(headers) });
}

function authedAccount(overrides: Record<string, any> = {}) {
  return { id: 'acct-1', teamId: TEAM_ID, level: 'worker', ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/health/budget', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetBudgetForecast.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindMany.mockReset();

    // Defaults: authenticated, team-wide query returns no workspaces
    mockAuthenticateApiKey.mockResolvedValue(authedAccount());
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockGetBudgetForecast.mockResolvedValue({
      oauthSessions: [],
      monthly: null,
      codex: null,
      missions: [],
    });
  });

  it('returns 401 when API key is missing or invalid', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await GET(makeRequest('http://localhost/api/health/budget'));
    expect(res.status).toBe(401);
  });

  it('returns 400 when account has no team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: null, level: 'worker' });
    const res = await GET(makeRequest('http://localhost/api/health/budget'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when workspaceId is not a valid UUID (e.g. a name like "buildd")', async () => {
    const res = await GET(makeRequest('http://localhost/api/health/budget?workspaceId=buildd'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/uuid/i);
  });

  it('returns 400 for other non-UUID workspace id formats', async () => {
    const res = await GET(makeRequest('http://localhost/api/health/budget?workspaceId=my-workspace'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when workspace UUID is not found', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(null);
    const res = await GET(makeRequest(`http://localhost/api/health/budget?workspaceId=${VALID_UUID}`));
    expect(res.status).toBe(404);
  });

  it('returns 404 when workspace belongs to a different team', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: VALID_UUID, teamId: 'other-team' });
    const res = await GET(makeRequest(`http://localhost/api/health/budget?workspaceId=${VALID_UUID}`));
    expect(res.status).toBe(404);
  });

  it('returns 200 with forecast for a valid workspace UUID', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: VALID_UUID, teamId: TEAM_ID });
    const res = await GET(makeRequest(`http://localhost/api/health/budget?workspaceId=${VALID_UUID}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.forecast).toBeDefined();
  });

  it('returns 200 team-wide forecast when no workspaceId is given', async () => {
    mockWorkspacesFindMany.mockResolvedValue([{ id: VALID_UUID }]);
    const res = await GET(makeRequest('http://localhost/api/health/budget'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.forecast).toBeDefined();
  });

  it('returns 200 with monthly: null when workspace has no usage rows (no workers in window)', async () => {
    // getBudgetForecast returns monthly: null when no monthly cap is configured
    mockGetBudgetForecast.mockResolvedValue({
      oauthSessions: [],
      monthly: null,
      codex: null,
      missions: [],
    });
    const res = await GET(makeRequest('http://localhost/api/health/budget'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.forecast.monthly).toBeNull();
  });

  it('returns a structured error (not empty body) when getBudgetForecast throws', async () => {
    mockGetBudgetForecast.mockRejectedValue(new Error('DB connection lost'));
    const res = await GET(makeRequest('http://localhost/api/health/budget'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/DB connection lost/i);
  });
});

describe('GET /api/health/budget — dashboard session', () => {
  const BASE = 'http://localhost/api/health/budget';
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockGetCurrentUser.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetTeamWorkspaceIds.mockReset();
    mockResolveActiveTeamId.mockReset();

    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockImplementation(async () => [TEAM_ID, TEAM_B]);
    mockGetTeamWorkspaceIds.mockImplementation(async (teamId: string) => (teamId === TEAM_ID ? [VALID_UUID] : [WS_B]));
    mockResolveActiveTeamId.mockImplementation(async () => TEAM_ID);
    mockGetBudgetForecast.mockReset();
    mockGetBudgetForecast.mockResolvedValue({ oauthSessions: [], monthly: null, codex: null, missions: [] });
  });

  it('forecasts the active team (buildd-team cookie) by default', async () => {
    const res = await GET(makeRequest(BASE, { cookie: `buildd-team=${TEAM_B}` }));
    expect(res.status).toBe(200);
    expect(mockResolveActiveTeamId).toHaveBeenCalledWith('user-1', TEAM_B);
    // resolveActiveTeamId is mocked to TEAM_ID here, so that team is forecast.
    expect(mockGetBudgetForecast).toHaveBeenCalledWith(TEAM_ID, [VALID_UUID]);
  });

  it('forecasts the pinned team when ?teamId is one of the user teams', async () => {
    const res = await GET(makeRequest(`${BASE}?teamId=${TEAM_B}`));
    expect(res.status).toBe(200);
    expect(mockGetBudgetForecast).toHaveBeenCalledWith(TEAM_B, [WS_B]);
  });

  it('scopes to one workspace, forecasting its own team', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: WS_B, teamId: TEAM_B });
    const res = await GET(makeRequest(`${BASE}?workspaceId=${WS_B}`));
    expect(res.status).toBe(200);
    expect(mockGetBudgetForecast).toHaveBeenCalledWith(TEAM_B, [WS_B]);
  });

  it('404s a workspace outside the user teams', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: VALID_UUID, teamId: 'other-team' });
    const res = await GET(makeRequest(`${BASE}?workspaceId=${VALID_UUID}`));
    expect(res.status).toBe(404);
    expect(mockGetBudgetForecast).not.toHaveBeenCalled();
  });

  it('?teamId bounds an explicit workspaceId: a team-B workspace 404s under ?teamId=team A', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: WS_B, teamId: TEAM_B });
    const res = await GET(makeRequest(`${BASE}?teamId=${TEAM_ID}&workspaceId=${WS_B}`));
    expect(res.status).toBe(404);
    expect(mockGetBudgetForecast).not.toHaveBeenCalled();
  });

  it('404s a pin to a team the user is not in', async () => {
    const res = await GET(makeRequest(`${BASE}?teamId=team-z`));
    expect(res.status).toBe(404);
    expect(mockGetBudgetForecast).not.toHaveBeenCalled();
  });

  it('400s a user with no team', async () => {
    mockResolveActiveTeamId.mockImplementation(async () => null);
    mockGetUserTeamIds.mockImplementation(async () => []);
    const res = await GET(makeRequest(BASE));
    expect(res.status).toBe(400);
  });

  it('401s with neither a session nor a key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(makeRequest(BASE));
    expect(res.status).toBe(401);
  });

  it('keeps a present key authoritative (teamId ignored)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(authedAccount());
    mockWorkspacesFindMany.mockResolvedValue([{ id: VALID_UUID }]);
    const res = await GET(makeRequest(`${BASE}?teamId=${TEAM_B}`, { authorization: 'Bearer bld_test' }));
    expect(res.status).toBe(200);
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
    expect(mockGetBudgetForecast).toHaveBeenCalledWith(TEAM_ID, [VALID_UUID]);
  });
});
