import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => Promise.resolve(null as any));
const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
const mockResolveAccountTeamIds = mock(() => Promise.resolve([] as string[]));
const mockWorkspacesFindMany = mock(() => Promise.resolve([] as any[]));
const mockFetchActionEvents = mock(() => Promise.resolve([] as any[]));
const mockCountWorkersInWindow = mock(() => Promise.resolve(0));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: mockResolveAccountTeamIds }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findMany: mockWorkspacesFindMany },
    },
  },
}));

mock.module('@/lib/action-events', () => ({
  ACTION_EVENTS_CAPTURED_SINCE: '2026-09-03',
  ACTION_EVENTS_ROW_LIMIT: 5000,
  fetchActionEvents: mockFetchActionEvents,
  countWorkersInWindow: mockCountWorkersInWindow,
}));

import { GET } from './route';

function makeRequest(params: Record<string, string> = {}, apiKey?: string) {
  const url = new URL('http://localhost/api/stats/actions');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest(url.toString(), { headers });
}

const user = { id: 'user-1' };

function event(overrides: Record<string, any> = {}) {
  return {
    workerId: crypto.randomUUID(),
    taskId: 'task-1',
    action: 'create_pr',
    ts: new Date('2026-09-02T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockAuthenticateApiKey.mockReset();
  mockResolveAccountTeamIds.mockReset();
  mockWorkspacesFindMany.mockReset();
  mockFetchActionEvents.mockReset();
  mockCountWorkersInWindow.mockReset();

  mockGetCurrentUser.mockResolvedValue(null);
  mockAuthenticateApiKey.mockResolvedValue(null);
  mockResolveAccountTeamIds.mockResolvedValue([]);
  mockWorkspacesFindMany.mockResolvedValue([]);
  mockFetchActionEvents.mockResolvedValue([]);
  mockCountWorkersInWindow.mockResolvedValue(0);
});

describe('GET /api/stats/actions — auth and validation', () => {
  it('401s with neither a session nor an API key', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('accepts a session user', async () => {
    mockGetCurrentUser.mockResolvedValue(user);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });

  it('400s an out-of-set window instead of silently mislabeling data', async () => {
    mockGetCurrentUser.mockResolvedValue(user);
    const res = await GET(makeRequest({ window: 'banana' }));
    expect(res.status).toBe(400);
    expect(mockFetchActionEvents).not.toHaveBeenCalled();
  });

  it('404s a workspace outside the caller\'s teams', async () => {
    mockGetCurrentUser.mockResolvedValue(user);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);

    const res = await GET(makeRequest({ workspace: 'ws-other' }));
    expect(res.status).toBe(404);
    expect(mockFetchActionEvents).not.toHaveBeenCalled();
  });

  it('returns an empty shape when the caller has no workspaces', async () => {
    mockGetCurrentUser.mockResolvedValue(user);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.coverage).toEqual({ workers: 0, workersWithEvents: 0 });
    expect(mockFetchActionEvents).not.toHaveBeenCalled();
  });
});

describe('GET /api/stats/actions — response shape', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockResolvedValue(user);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
  });

  it('always states the capture start date', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.capturedSince).toBe('2026-09-03');
  });

  it('surfaces raw events and the third coverage class', async () => {
    mockFetchActionEvents.mockResolvedValue([
      event({ workerId: 'w-1', action: 'create_pr' }),
      event({ workerId: 'w-1', action: 'update_progress' }),
      event({ workerId: 'w-2', action: 'recall' }),
    ]);
    mockCountWorkersInWindow.mockResolvedValue(10);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.events).toHaveLength(3);
    expect(body.events[0]).toMatchObject({ workerId: 'w-1', taskId: 'task-1', action: 'create_pr' });
    // Third coverage class: workers with at least one captured event, out of the
    // full terminal-worker population — distinct from tools.coverage's histogram/derived/none.
    expect(body.coverage).toEqual({ workers: 10, workersWithEvents: 2 });
    expect(body.truncated).toBe(false);
  });

  it('flags truncation when the row cap is hit', async () => {
    mockFetchActionEvents.mockResolvedValue(
      Array.from({ length: 5000 }, (_, i) => event({ workerId: `w-${i}` })),
    );
    mockCountWorkersInWindow.mockResolvedValue(5000);

    const body = await (await GET(makeRequest())).json();
    expect(body.truncated).toBe(true);
  });

  it('rejects a bad window before hitting the data layer', async () => {
    const res = await GET(makeRequest({ window: '14d' }));
    expect(res.status).toBe(400);
  });

  it('accepts each of the three supported windows', async () => {
    for (const window of ['24h', '7d', '30d']) {
      const res = await GET(makeRequest({ window }));
      expect(res.status).toBe(200);
    }
  });
});
