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
