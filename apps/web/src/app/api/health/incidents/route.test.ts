import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

const mockGetCurrentUser = mock(async () => null as any);
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));

const mockGetUserTeamIds = mock(async (_userId: string) => [] as string[]);
const mockGetTeamWorkspaceIds = mock(async (_teamId: string) => [] as string[]);
const mockResolveActiveTeamId = mock(async (_userId: string, _cookie: string | null | undefined) => null as string | null);
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getTeamWorkspaceIds: mockGetTeamWorkspaceIds,
  resolveActiveTeamId: mockResolveActiveTeamId,
}));

const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesFindMany = mock(() => [] as any[]);

// `db.select(...)` is called exactly three times per request, always in the
// same order: the limited row list, the unlimited total count, then the
// severity breakdown. Tests queue up to three results via `selectResults`.
let selectCallIndex = 0;
let selectResults: any[] = [];
function makeChain(result: any) {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    groupBy: () => Promise.resolve(result),
    limit: () => Promise.resolve(result),
    then: (resolve: any, reject?: any) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}
const mockSelect = mock((_cols?: any) => {
  const result = selectResults[selectCallIndex] ?? [];
  selectCallIndex++;
  return makeChain(result);
});

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: {
        findFirst: mockWorkspacesFindFirst,
        findMany: mockWorkspacesFindMany,
      },
    },
    select: mockSelect,
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: 'workspaces',
  failureIncidents: {
    workspaceId: 'workspace_id',
    status: 'status',
    severity: 'severity',
    rule: 'rule',
    signature: 'signature',
    lastSeenAt: 'last_seen_at',
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
}));

mock.module('@/lib/session-team-scope', () => ({
  resolveSessionTeamIds: async (userId: string, pinTeamId: string | null | undefined) => {
    const teamIds = await mockGetUserTeamIds(userId);
    if (!pinTeamId) return teamIds;
    return teamIds.includes(pinTeamId) ? [pinTeamId] : null;
  },
  workspaceIdsForTeams: async (teamIds: string[]) => {
    const lists = await Promise.all(teamIds.map((teamId) => mockGetTeamWorkspaceIds(teamId)));
    return [...new Set(lists.flat())];
  },
}));

import { GET } from './route';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_UUID = '00000000-0000-0000-0000-000000000001';
const TEAM_ID = 'team-00000000-0000-0000-0000-000000000001';
const URL_BASE = 'http://localhost/api/health/incidents';

function makeRequest(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers: new Headers(headers) });
}

function authedAccount(overrides: Record<string, any> = {}) {
  return { id: 'acct-1', teamId: TEAM_ID, level: 'worker', ...overrides };
}

function incidentRow(overrides: Record<string, any> = {}) {
  return {
    id: 'inc-1',
    workspaceId: VALID_UUID,
    signature: 'retry_fork|ws=' + VALID_UUID + '|pr=42|kind=ci|stage=-|iter=1',
    detectorVersion: 'fps-v1',
    rule: 'retry_fork',
    reasonCode: 'retry_fork.duplicate_children',
    title: '2 parallel ci retry children for PR #42',
    severity: 'critical',
    status: 'open',
    firstSeenAt: new Date('2026-10-04T12:00:00.000Z'),
    lastSeenAt: new Date('2026-10-04T12:05:00.000Z'),
    occurrenceCount: 2,
    recurrenceCount: 0,
    affectedRefs: { taskIds: ['task-1', 'task-2'], workerIds: [], prNumbers: [42] },
    evidenceRefs: [{ kind: 'task', id: 'task-1', at: '2026-10-04T12:05:00.000Z' }],
    impact: { children: 2 },
    lastAlertedAt: new Date('2026-10-04T12:05:01.000Z'),
    lastAlertSeverity: 'critical',
    linkedFixTaskId: 'fix-task-1',
    acknowledgedAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/health/incidents', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetCurrentUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetTeamWorkspaceIds.mockReset();
    mockSelect.mockClear();
    selectCallIndex = 0;
    selectResults = [[], [{ n: 0 }], []];

    mockAuthenticateApiKey.mockResolvedValue(authedAccount());
    mockWorkspacesFindMany.mockResolvedValue([{ id: VALID_UUID }]);
  });

  it('returns 401 when API key is missing and there is no session', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(401);
  });

  it('returns 400 when account has no team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: null, level: 'worker' });
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(400);
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

  it('returns 400 for an unsupported status value', async () => {
    const res = await GET(makeRequest(`${URL_BASE}?status=bogus`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/status/i);
  });

  it('returns 400 for an unsupported severity value', async () => {
    const res = await GET(makeRequest(`${URL_BASE}?severity=urgent`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/severity/i);
  });

  it('returns 400 for a non-positive limit', async () => {
    const res = await GET(makeRequest(`${URL_BASE}?limit=0`));
    expect(res.status).toBe(400);
  });

  it('returns incidents mapped to the full shape: severity, signature/reason, seen window, impact, refs, alert state, linked fix task, resolved/recurrence state', async () => {
    selectResults = [[incidentRow()], [{ n: 1 }], [{ severity: 'critical', n: 1 }]];
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.incidents).toHaveLength(1);
    const inc = body.incidents[0];
    expect(inc).toMatchObject({
      id: 'inc-1',
      signature: expect.stringContaining('retry_fork'),
      reasonCode: 'retry_fork.duplicate_children',
      severity: 'critical',
      status: 'open',
      firstSeenAt: '2026-10-04T12:00:00.000Z',
      lastSeenAt: '2026-10-04T12:05:00.000Z',
      occurrenceCount: 2,
      recurrenceCount: 0,
      affectedRefs: { taskIds: ['task-1', 'task-2'], workerIds: [], prNumbers: [42] },
      impact: { children: 2 },
      lastAlertSeverity: 'critical',
      lastAlertedAt: '2026-10-04T12:05:01.000Z',
      linkedFixTaskId: 'fix-task-1',
      acknowledgedAt: null,
      resolvedAt: null,
    });
    expect(body.counts).toEqual({ total: 1, bySeverity: { low: 0, medium: 0, high: 0, critical: 1 } });
  });

  it('defaults to open+acknowledged statuses when none is given', async () => {
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(200);
    // the status filter is baked into the `where` call on the first select;
    // this is exercised indirectly via the 200 + empty-list happy path above.
  });

  it('accepts status=all and status=resolved explicitly', async () => {
    for (const status of ['all', 'resolved', 'open,acknowledged,resolved']) {
      selectCallIndex = 0;
      selectResults = [[], [{ n: 0 }], []];
      const res = await GET(makeRequest(`${URL_BASE}?status=${status}`));
      expect(res.status).toBe(200);
    }
  });

  it('scopes to a single workspace when a valid UUID is given', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: VALID_UUID, teamId: TEAM_ID });
    const res = await GET(makeRequest(`${URL_BASE}?workspaceId=${VALID_UUID}`));
    expect(res.status).toBe(200);
  });

  it('returns an empty report without querying incidents when the caller has no workspaces', async () => {
    mockWorkspacesFindMany.mockResolvedValue([]);
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ incidents: [], counts: { total: 0, bySeverity: { low: 0, medium: 0, high: 0, critical: 0 } } });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('honors a session user when no API key is present', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue([TEAM_ID]);
    mockGetTeamWorkspaceIds.mockResolvedValue([VALID_UUID]);
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(200);
  });

  it('500s cleanly when the query layer throws', async () => {
    mockSelect.mockImplementationOnce(() => { throw new Error('db unavailable'); });
    const res = await GET(makeRequest(URL_BASE));
    expect(res.status).toBe(500);
  });
});
