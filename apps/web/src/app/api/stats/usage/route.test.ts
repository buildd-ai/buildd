import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => Promise.resolve(null as any));
const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
const mockResolveAccountTeamIds = mock(() => Promise.resolve([] as string[]));
const mockWorkspacesFindMany = mock(() => Promise.resolve([] as any[]));
const mockWorkersFindMany = mock(() => Promise.resolve([] as any[]));
const mockSkillsFindMany = mock(() => Promise.resolve([] as any[]));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: mockResolveAccountTeamIds }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
      workspaceSkills: { findMany: mockSkillsFindMany },
    },
  },
}));

import { GET } from './route';

function makeRequest(params: Record<string, string> = {}, apiKey?: string) {
  const url = new URL('http://localhost/api/stats/usage');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest(url.toString(), { headers });
}

const user = { id: 'user-1' };

/** Unwrap a DerivedMetric distribution from the JSON body. */
function dist(m: any) {
  if (m?.kind !== 'value') throw new Error(`expected a value, got: ${JSON.stringify(m)}`);
  return m.value;
}

function worker(overrides: Record<string, any> = {}) {
  return {
    id: crypto.randomUUID(),
    taskId: 'task-1',
    workspaceId: 'ws-1',
    inputTokens: 20_000,
    outputTokens: 2_000,
    costUsd: '1.25',
    turns: 12,
    resultMeta: null,
    mcpCalls: null,
    task: { id: 'task-1', status: 'completed', roleSlug: 'builder', parentTaskId: null },
    ...overrides,
  };
}

beforeEach(() => {
  mockGetCurrentUser.mockReset();
  mockAuthenticateApiKey.mockReset();
  mockResolveAccountTeamIds.mockReset();
  mockWorkspacesFindMany.mockReset();
  mockWorkersFindMany.mockReset();
  mockSkillsFindMany.mockReset();

  mockGetCurrentUser.mockResolvedValue(null);
  mockAuthenticateApiKey.mockResolvedValue(null);
  mockResolveAccountTeamIds.mockResolvedValue([]);
  mockWorkspacesFindMany.mockResolvedValue([]);
  mockWorkersFindMany.mockResolvedValue([]);
  mockSkillsFindMany.mockResolvedValue([]);
});

describe('GET /api/stats/usage — auth', () => {
  it('401s with neither a session nor an API key', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('accepts a session user', async () => {
    mockGetCurrentUser.mockResolvedValue(user);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });

  it('accepts an API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'write' });
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', name: 'Buildd' }]);
    const res = await GET(makeRequest({}, 'bld_test'));
    expect(res.status).toBe(200);
  });

  it('404s a workspace outside the caller\'s teams instead of leaking its usage', async () => {
    mockGetCurrentUser.mockResolvedValue(user);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', name: 'Buildd' }]);

    const res = await GET(makeRequest({ workspace: 'ws-other' }));
    expect(res.status).toBe(404);
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
  });

  it('returns an empty shape when the caller has no workspaces', async () => {
    mockGetCurrentUser.mockResolvedValue(user);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.totals.tasks).toBe(0);
    expect(body.groups).toEqual([]);
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/stats/usage — aggregation', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockResolvedValue(user);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Buildd' },
      { id: 'ws-2', name: 'Docs' },
    ]);
  });

  it('reports tokens, cost and turns per task', async () => {
    mockWorkersFindMany.mockResolvedValue([
      worker({ taskId: 'a', task: { id: 'a', status: 'completed', roleSlug: 'builder', parentTaskId: null } }),
      worker({
        taskId: 'b', inputTokens: 60_000, costUsd: '3.00', turns: 30,
        task: { id: 'b', status: 'completed', roleSlug: 'builder', parentTaskId: null },
      }),
    ]);

    const body = await (await GET(makeRequest())).json();
    expect(body.totals.tasks).toBe(2);
    expect(body.totals.inputTokens).toBe(80_000);
    expect(body.totals.costUsd).toBeCloseTo(4.25);
    expect(dist(body.perTask.inputTokens).max).toBe(60_000);
    expect(dist(body.perTask.turns).mean).toBe(21);
  });

  it('surfaces the tool histogram with per-server breakdown', async () => {
    mockWorkersFindMany.mockResolvedValue([
      worker({
        resultMeta: {
          stopReason: 'end_turn', durationMs: 1, durationApiMs: 1, numTurns: 12, modelUsage: {},
          toolCounts: { Read: 40, Bash: 25, Edit: 10, 'mcp__buildd__buildd': 5 },
        },
      }),
    ]);

    const body = await (await GET(makeRequest())).json();
    expect(body.tools.byTool[0]).toMatchObject({ name: 'Read', calls: 40, tasks: 1 });
    expect(body.tools.coverage.histogramRate).toBe(1);
    const servers = Object.fromEntries(body.tools.byServer.map((s: any) => [s.server, s.calls]));
    expect(servers['built-in']).toBe(75);
    expect(servers['buildd']).toBe(5);
  });

  it('flags that tool numbers are derived for pre-histogram workers', async () => {
    mockWorkersFindMany.mockResolvedValue([
      worker({ mcpCalls: [{ server: 'buildd', tool: 'buildd', ts: 1, ok: true }] }),
    ]);

    const body = await (await GET(makeRequest())).json();
    expect(body.tools.coverage).toMatchObject({ tasks: 1, histogram: 0, derived: 1 });
    expect(body.tools.coverage.histogramRate).toBe(0);
  });

  it('labels role groups with the role name and reports success rate', async () => {
    mockSkillsFindMany.mockResolvedValue([{ slug: 'builder', name: 'Builder' }]);
    mockWorkersFindMany.mockResolvedValue([
      worker({ taskId: 'a', task: { id: 'a', status: 'completed', roleSlug: 'builder', parentTaskId: null } }),
      worker({ taskId: 'b', task: { id: 'b', status: 'failed', roleSlug: 'builder', parentTaskId: null } }),
    ]);

    const body = await (await GET(makeRequest({ groupBy: 'role' }))).json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({ key: 'builder', label: 'Builder', tasks: 2 });
    expect(body.groups[0].successRate).toBeCloseTo(0.5);
  });

  it('labels workspace groups with the workspace name', async () => {
    mockWorkersFindMany.mockResolvedValue([
      worker({ taskId: 'a', workspaceId: 'ws-1', task: { id: 'a', status: 'completed', roleSlug: null, parentTaskId: null } }),
      worker({ taskId: 'b', workspaceId: 'ws-2', inputTokens: 1, task: { id: 'b', status: 'completed', roleSlug: null, parentTaskId: null } }),
    ]);

    const body = await (await GET(makeRequest({ groupBy: 'workspace' }))).json();
    expect(body.groups.map((g: any) => g.label)).toEqual(['Buildd', 'Docs']);
    expect(mockSkillsFindMany).not.toHaveBeenCalled();
  });

  it('charges a retry attempt to its parent task', async () => {
    mockWorkersFindMany.mockResolvedValue([
      worker({ taskId: 'parent', task: { id: 'parent', status: 'completed', roleSlug: 'builder', parentTaskId: null } }),
      worker({
        taskId: 'attempt', inputTokens: 5_000,
        task: { id: 'attempt', status: 'failed', roleSlug: 'builder', parentTaskId: 'parent' },
      }),
    ]);

    const body = await (await GET(makeRequest())).json();
    expect(body.totals.tasks).toBe(1);
    expect(body.totals.workers).toBe(2);
    expect(body.totals.inputTokens).toBe(25_000);
    expect(body.groups[0].successRate).toBe(1);
  });

  it('falls back to the default window and role grouping on bad params', async () => {
    const body = await (await GET(makeRequest({ window: 'banana', groupBy: 'sideways' }))).json();
    expect(body.window).toBe('banana');
    expect(body.groupBy).toBe('role');
    const ageMs = Date.now() - new Date(body.windowStart).getTime();
    expect(ageMs).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(ageMs).toBeLessThan(7.1 * 24 * 3600_000);
  });

  it('scans a single workspace when one is requested', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    const body = await (await GET(makeRequest({ workspace: 'ws-2' }))).json();
    expect(body.workspaceIds).toEqual(['ws-2']);
  });

  it('reports cost as unavailable on a seat-auth window instead of $0.00', async () => {
    mockWorkersFindMany.mockResolvedValue([
      worker({ taskId: 'a', costUsd: '0' }),
      worker({ taskId: 'b', costUsd: '0' }),
    ]);

    const body = await (await GET(makeRequest())).json();
    expect(body.perTask.costUsd.kind).toBe('unavailable');
    expect(body.perTask.costUsd.reason).toMatch(/seat-based/);
    expect(dist(body.perTask.inputTokens).median).toBe(20_000);
  });

  it('excludes tasks that recorded nothing from the token median', async () => {
    mockWorkersFindMany.mockResolvedValue([
      worker({ taskId: 'a', inputTokens: 40_000 }),
      worker({ taskId: 'b', inputTokens: 0, outputTokens: 0, turns: 0 }),
      worker({ taskId: 'c', inputTokens: 0, outputTokens: 0, turns: 0 }),
    ]);

    const body = await (await GET(makeRequest())).json();
    expect(dist(body.perTask.inputTokens).median).toBe(40_000);
    expect(body.perTask.contributing.inputTokens).toBe(1);
    expect(body.perTask.tasks).toBe(3);
  });

  it('does not flag truncation on a normal-sized scan', async () => {
    mockWorkersFindMany.mockResolvedValue([worker()]);
    const body = await (await GET(makeRequest())).json();
    expect(body.truncatedScan).toBe(false);
  });
});
