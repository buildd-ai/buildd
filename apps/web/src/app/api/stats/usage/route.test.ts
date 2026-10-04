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

const mockFetchActionEvents = mock(() => Promise.resolve([] as any[]));
const mockCountWorkers = mock(() => Promise.resolve(0));
mock.module('@/lib/action-events', () => ({
  ACTION_EVENTS_CAPTURED_SINCE: '2026-09-03',
  ACTION_EVENTS_ROW_LIMIT: 5000,
  fetchActionEvents: mockFetchActionEvents,
  countWorkersInWindow: mockCountWorkers,
}));

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
  mockFetchActionEvents.mockReset();
  mockCountWorkers.mockReset();
  mockFetchActionEvents.mockResolvedValue([]);
  mockCountWorkers.mockResolvedValue(0);
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

  it('labels an inferred role group apart from the stated one', async () => {
    mockSkillsFindMany.mockResolvedValue([{ slug: 'builder', name: 'Builder' }]);
    mockWorkersFindMany.mockResolvedValue([
      worker({ taskId: 'a', task: { id: 'a', status: 'completed', roleSlug: 'builder', parentTaskId: null } }),
      worker({ taskId: 'b', task: { id: 'b', status: 'completed', roleSlug: 'builder', parentTaskId: null, roleInferred: true } }),
    ]);

    const body = await (await GET(makeRequest({ groupBy: 'role' }))).json();
    const byKey = Object.fromEntries(body.groups.map((g: any) => [g.key, g]));
    expect(byKey.builder).toMatchObject({ label: 'Builder', roleSource: 'stated', tasks: 1 });
    expect(byKey['builder · inferred']).toMatchObject({ label: 'Builder · inferred', roleSource: 'inferred', tasks: 1 });
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

  it('groups by executor from workers.runner, labels both groups, and skips the role lookup', async () => {
    mockWorkersFindMany.mockResolvedValue([
      worker({ taskId: 'a', runner: 'mcp', task: { id: 'a', status: 'completed', roleSlug: 'builder', parentTaskId: null } }),
      worker({ taskId: 'b', runner: 'coder-ws-1', inputTokens: 1, task: { id: 'b', status: 'completed', roleSlug: 'builder', parentTaskId: null } }),
      worker({ taskId: 'c', runner: 'coder-ws-1', inputTokens: 1, task: { id: 'c', status: 'failed', roleSlug: 'builder', parentTaskId: null } }),
    ]);

    const body = await (await GET(makeRequest({ groupBy: 'executor' }))).json();
    expect(body.groupBy).toBe('executor');
    const byKey = Object.fromEntries(body.groups.map((g: any) => [g.key, g]));
    expect(byKey.interactive).toMatchObject({ label: 'Interactive (MCP session)', tasks: 1, completed: 1 });
    expect(byKey.runner).toMatchObject({ label: 'Runner', tasks: 2, completed: 1, failed: 1 });
    expect(mockSkillsFindMany).not.toHaveBeenCalled();

    // The executor comes from the worker row itself, so the scan must select it.
    const args = mockWorkersFindMany.mock.calls[0][0] as any;
    expect(args.columns.runner).toBe(true);
  });

  it('groups by creationSource with the raw key as label and skips the role lookup', async () => {
    mockWorkersFindMany.mockResolvedValue([
      worker({ taskId: 'a', task: { id: 'a', status: 'completed', roleSlug: null, creationSource: 'dashboard', parentTaskId: null } }),
      worker({ taskId: 'b', inputTokens: 1, task: { id: 'b', status: 'completed', roleSlug: null, creationSource: 'mcp', parentTaskId: null } }),
    ]);

    const body = await (await GET(makeRequest({ groupBy: 'creationSource' }))).json();
    expect(body.groups.map((g: any) => g.key).sort()).toEqual(['dashboard', 'mcp']);
    // Raw key doubles as the label — no role-slug lookup should fire for it.
    expect(body.groups.find((g: any) => g.key === 'dashboard').label).toBe('dashboard');
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

  it('falls back to role grouping on a bad groupBy', async () => {
    const body = await (await GET(makeRequest({ groupBy: 'sideways' }))).json();
    expect(body.groupBy).toBe('role');
    const ageMs = Date.now() - new Date(body.windowStart).getTime();
    expect(ageMs).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(ageMs).toBeLessThan(7.1 * 24 * 3600_000);
  });

  // Pre-existing bug: an unparsable window used to be echoed back verbatim and
  // silently resolved to 7d data mislabelled with the caller's garbage string
  // (`?window=banana` → 7-day data labelled "banana"). Reject it instead.
  it('400s on a window outside the closed set instead of silently mislabeling 7d data', async () => {
    const res = await GET(makeRequest({ window: 'banana' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid window/);
    expect(body.error).toMatch(/24h, 7d, 30d/);
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
  });

  it.each(['24h', '7d', '30d'] as const)('accepts window=%s and labels the response with it', async (window) => {
    mockWorkersFindMany.mockResolvedValue([worker()]);
    const body = await (await GET(makeRequest({ window }))).json();
    expect(body.window).toBe(window);
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
    expect(body.perTask.costUsd.detail).toMatch(/seat-based/);
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
    expect(body.scan.truncated).toBe(false);
    expect(body.scan.completeSince).toBe(body.windowStart);
  });

  /**
   * C23: the row cap was applied to an UNORDERED scan, so a truncated request
   * got an arbitrary 5000 of the window's workers. Totals being "a floor" is
   * honest for additive metrics; a p50/p90 over an arbitrary subset is not a
   * percentile of anything. Ordering by completedAt desc makes the scanned set
   * the COMPLETE population of a narrower window, which the response names.
   */
  it('orders the scan deterministically so a truncated window is a real window', async () => {
    mockWorkersFindMany.mockResolvedValue([worker()]);
    await GET(makeRequest());
    const args = mockWorkersFindMany.mock.calls[0][0] as any;
    expect(Array.isArray(args.orderBy)).toBe(true);
    expect(args.orderBy.length).toBeGreaterThan(0);
    expect(args.limit).toBe(5000);
  });

  it('names the window its distributions actually cover when the scan is truncated', async () => {
    // 5000 rows, newest first (what the ordered query returns).
    const rows = Array.from({ length: 5000 }, (_, i) =>
      worker({
        taskId: `task-${i}`,
        completedAt: new Date(Date.UTC(2026, 7, 20, 0, 0, 0) - i * 60_000),
      }),
    );
    mockWorkersFindMany.mockResolvedValue(rows);

    const body = await (await GET(makeRequest({ window: '30d' }))).json();
    expect(body.truncatedScan).toBe(true);
    expect(body.scan.truncated).toBe(true);
    expect(body.scan.rows).toBe(5000);
    expect(body.scan.limit).toBe(5000);
    // The oldest row actually scanned, not the requested 30d boundary.
    expect(body.scan.completeSince).toBe(rows[4999].completedAt.toISOString());
    expect(body.scan.completeSince).not.toBe(body.windowStart);
  });
});

describe('GET /api/stats/usage — fine-grained breakdowns', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockResolvedValue(user);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', name: 'Buildd' }]);
  });

  it('returns bash buckets, search shapes, buildd actions and graph tools, each with its own population', async () => {
    mockWorkersFindMany.mockResolvedValue([
      worker({
        resultMeta: {
          toolCounts: { Bash: 5, 'mcp__codebase-memory__search_graph': 2 },
          bashCommandCounts: { total: 5, buckets: { code_search: 3, test: 2 }, searchShapes: { identifier: 3 } },
          cbm: { outcome: 'enforced', toolCalls: { search_graph: 2 }, totalCbmCalls: 2, readCount: 0, grepCount: 0, globCount: 0 },
        },
      }),
    ]);
    mockFetchActionEvents.mockResolvedValue([
      { workerId: 'w1', taskId: 'task-1', action: 'update_progress', ts: new Date() },
      { workerId: 'w1', taskId: 'task-1', action: 'complete_task', ts: new Date() },
    ]);
    mockCountWorkers.mockResolvedValue(1);

    const body = await (await GET(makeRequest())).json();

    expect(body.bashBuckets.histogramTasks).toBe(1);
    expect(body.bashBuckets.classifiedCalls).toBe(5);
    expect(body.searchShapes.codeSearchCalls).toBe(3);
    expect(body.searchShapes.shapes[0]).toMatchObject({ key: 'identifier', calls: 3 });
    expect(body.buildActions.totalCalls).toBe(2);
    expect(body.buildActions.capturedSince).toBe('2026-09-03');
    expect(body.buildActions.workers).toBe(1);
    expect(body.cbmTools.sessions).toBe(1);
    expect(body.cbmTools.tools[0]).toMatchObject({ tool: 'search_graph', calls: 2, sessions: 1 });
  });

  it('nulls a breakdown whose read failed instead of failing the response', async () => {
    mockWorkersFindMany.mockResolvedValue([worker()]);
    mockFetchActionEvents.mockRejectedValue(new Error('boom'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.buildActions).toBeNull();
    expect(body.cbmTools).toBeNull();
    expect(body.totals.tasks).toBe(1);
  });
});

// A per-task token (cloud container, and self-hosted agents once they carry
// one) reads usage only for its own task's workspace, never team-wide.
describe('GET /api/stats/usage — per-task token', () => {
  const SCOPED = { id: 'acct-1', teamId: 'team-1', level: 'worker', taskScope: { taskId: 'task-own', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };

  beforeEach(() => {
    mockAuthenticateApiKey.mockResolvedValue(SCOPED);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Buildd' },
      { id: 'ws-2', name: 'Docs' },
    ]);
  });

  it('defaults to its own workspace, not the whole team', async () => {
    mockWorkersFindMany.mockResolvedValue([worker()]);
    const res = await GET(makeRequest({ groupBy: 'workspace' }, 'bld_test'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceIds).toEqual(['ws-1']);
    expect(JSON.stringify(body)).not.toContain('Docs');
  });

  it('reads its own workspace when asked for it', async () => {
    const res = await GET(makeRequest({ workspace: 'ws-1' }, 'bld_test'));
    expect(res.status).toBe(200);
    expect((await res.json()).workspaceIds).toEqual(['ws-1']);
  });

  it('404s another workspace on the same team before reading anything', async () => {
    const res = await GET(makeRequest({ workspace: 'ws-2' }, 'bld_test'));
    expect(res.status).toBe(404);
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
  });

  it('an account key still reads the whole team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'worker' });
    const body = await (await GET(makeRequest({}, 'bld_test'))).json();
    expect(body.workspaceIds).toEqual(['ws-1', 'ws-2']);
  });
});
