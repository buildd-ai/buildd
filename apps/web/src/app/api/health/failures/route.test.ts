import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

const EMPTY_ANALYTICS = {
  window: '7d',
  generatedAt: '2026-08-28T12:00:00.000Z',
  windowStart: '2026-08-21T12:00:00.000Z',
  totals: { started: 0, completed: 0, failed: 0, failureRatePct: 0, diedEarly: 0, diedEarlySharePct: 0 },
  byExitCause: [],
  signatures: [],
  diedEarlySignatures: [],
  byRole: [],
  byWorkspace: [],
  repeatFailureTasks: [],
};

const mockGetFailureAnalytics = mock(() => Promise.resolve(EMPTY_ANALYTICS as any));
mock.module('@/lib/failure-analytics', () => ({
  getFailureAnalytics: mockGetFailureAnalytics,
  FAILURE_WINDOWS: ['24h', '7d', '30d'],
  parseFailureWindow: (raw: string | null | undefined) =>
    ['24h', '7d', '30d'].includes(raw ?? '') ? raw : '7d',
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
  gte: (field: any, value: any) => ({ field, value, type: 'gte' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

import { GET } from './route';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_UUID = '00000000-0000-0000-0000-000000000001';
const TEAM_ID = 'team-00000000-0000-0000-0000-000000000001';
const URL_BASE = 'http://localhost/api/health/failures';

function makeRequest(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers: new Headers(headers) });
}

function authedAccount(overrides: Record<string, any> = {}) {
  return { id: 'acct-1', teamId: TEAM_ID, level: 'worker', ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/health/failures', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetFailureAnalytics.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindMany.mockReset();

    mockAuthenticateApiKey.mockResolvedValue(authedAccount());
    mockWorkspacesFindMany.mockResolvedValue([{ id: VALID_UUID }]);
    mockGetFailureAnalytics.mockResolvedValue(EMPTY_ANALYTICS);
  });

  it('returns 401 when API key is missing or invalid', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(401);
  });

  it('returns 400 when account has no team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: null, level: 'worker' });
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unsupported window', async () => {
    const res = await GET(makeRequest(`${URL_BASE}?window=all-time`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/window/i);
  });

  it('returns 400 when workspaceId is not a UUID', async () => {
    const res = await GET(makeRequest(`${URL_BASE}?workspaceId=buildd`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/uuid/i);
  });

  it('returns 404 when the workspace does not exist', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(null);
    const res = await GET(makeRequest(`${URL_BASE}?workspaceId=${VALID_UUID}`));
    expect(res.status).toBe(404);
  });

  it('returns 404 when the workspace belongs to another team', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: VALID_UUID, teamId: 'other-team' });
    const res = await GET(makeRequest(`${URL_BASE}?workspaceId=${VALID_UUID}`));
    expect(res.status).toBe(404);
  });

  it('defaults to the 7d window when none is given', async () => {
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(200);
    expect(mockGetFailureAnalytics.mock.calls[0][1]).toBe('7d');
  });

  it('passes each supported window through to the aggregation', async () => {
    for (const w of ['24h', '7d', '30d']) {
      mockGetFailureAnalytics.mockClear();
      const res = await GET(makeRequest(`${URL_BASE}?window=${w}`));
      expect(res.status).toBe(200);
      expect(mockGetFailureAnalytics.mock.calls[0][1]).toBe(w);
    }
  });

  it('scopes to a single workspace when a valid UUID is given', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: VALID_UUID, teamId: TEAM_ID });
    const res = await GET(makeRequest(`${URL_BASE}?workspaceId=${VALID_UUID}`));
    expect(res.status).toBe(200);
    expect(mockGetFailureAnalytics.mock.calls[0][0]).toEqual([VALID_UUID]);
  });

  it('scopes to every team workspace when no workspaceId is given', async () => {
    mockWorkspacesFindMany.mockResolvedValue([{ id: VALID_UUID }, { id: 'ws-2' }]);
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(200);
    expect(mockGetFailureAnalytics.mock.calls[0][0]).toEqual([VALID_UUID, 'ws-2']);
  });

  it('returns the analytics payload under an "analytics" key', async () => {
    mockGetFailureAnalytics.mockResolvedValue({
      ...EMPTY_ANALYTICS,
      totals: { started: 10, completed: 7, failed: 3, failureRatePct: 30, diedEarly: 2, diedEarlySharePct: 67 },
      signatures: [
        {
          signature: 'Stale worker expired (no update for <n>+ minutes)',
          count: 3,
          firstSeen: '2026-08-22T00:00:00.000Z',
          lastSeen: '2026-08-27T00:00:00.000Z',
          exampleWorkerIds: ['w1'],
          exampleError: 'Stale worker expired (no update for 15+ minutes)',
          exampleTaskId: 't1',
          diedEarlyCount: 2,
          exitCauses: ['infra_failure'],
        },
      ],
    });
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analytics.totals.failureRatePct).toBe(30);
    expect(body.analytics.totals.diedEarly).toBe(2);
    expect(body.analytics.signatures[0].signature).toBe('Stale worker expired (no update for <n>+ minutes)');
  });

  it('returns a structured 500 when the aggregation throws', async () => {
    mockGetFailureAnalytics.mockRejectedValue(new Error('DB connection lost'));
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/DB connection lost/i);
  });
});
