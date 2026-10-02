import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, workerActions, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_WORKSPACE_ID = '00000000-0000-0000-0000-0000000000aa';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    workerId: '00000000-0000-0000-0000-000000000002',
    authType: 'oauth',
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

const statsPayload = {
  window: '7d',
  windowStart: '2026-08-22T00:00:00Z',
  workspaceIds: [MOCK_WORKSPACE_ID],
  truncatedScan: false,
  groupBy: 'role',
  totals: {
    tasks: 12, workers: 15,
    inputTokens: 21_600_000, outputTokens: 240_000,
    cacheReadTokens: 18_000_000, cacheCreationTokens: 400_000,
    costUsd: 42.5, turns: 300, toolCalls: 1_200,
  },
  perTask: {
    tasks: 12,
    contributing: { inputTokens: 10, outputTokens: 10, costUsd: 10, turns: 12, toolCalls: 11 },
    inputTokens: { kind: 'value', value: { mean: 1_800_000, median: 1_400_000, p90: 3_200_000, max: 4_000_000 } },
    outputTokens: { kind: 'value', value: { mean: 20_000, median: 18_000, p90: 30_000, max: 40_000 } },
    costUsd: { kind: 'value', value: { mean: 3.54, median: 2.1, p90: 8.0, max: 10.0 } },
    turns: { kind: 'value', value: { mean: 25, median: 22, p90: 40, max: 60 } },
    toolCalls: { kind: 'value', value: { mean: 100, median: 85, p90: 190, max: 240 } },
  },
  tools: {
    coverage: { tasks: 12, histogram: 9, derived: 2, none: 1, histogramRate: 0.75, truncated: 1 },
    byTool: [
      { name: 'Read', calls: 500, share: 0.4166, tasks: 11 },
      { name: 'Bash', calls: 400, share: 0.3333, tasks: 12 },
      { name: 'mcp__buildd__buildd', calls: 120, share: 0.1, tasks: 12 },
    ],
    byServer: [
      { server: 'built-in', calls: 1_000, tasks: 12 },
      { server: 'buildd', calls: 200, tasks: 12 },
    ],
  },
  byModel: [
    { model: 'claude-opus-5', inputTokens: 20_000_000, outputTokens: 200_000, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 40, share: 0.92 },
  ],
  groups: [
    {
      key: 'builder', label: 'Builder', tasks: 8, workers: 10,
      inputTokens: 18_000_000, outputTokens: 200_000, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: 36, turns: 240, toolCalls: 1_000,
      completed: 6, failed: 2, successRate: 0.75,
      perTask: {
        tasks: 8,
        contributing: { inputTokens: 8, outputTokens: 8, costUsd: 8, turns: 8, toolCalls: 8 },
        inputTokens: { kind: 'value', value: { mean: 2_250_000, median: 2_000_000, p90: 3_200_000, max: 4_000_000 } },
        outputTokens: { kind: 'value', value: { mean: 25_000, median: 22_000, p90: 30_000, max: 40_000 } },
        costUsd: { kind: 'value', value: { mean: 4.5, median: 3.2, p90: 8, max: 10 } },
        turns: { kind: 'value', value: { mean: 30, median: 28, p90: 40, max: 60 } },
        toolCalls: { kind: 'value', value: { mean: 125, median: 110, p90: 190, max: 240 } },
      },
    },
  ],
};

describe('get_usage_stats', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('is available to worker-level tokens', () => {
    expect(workerActions).toContain('get_usage_stats');
  });

  it('hits the stats endpoint and summarises tokens, cost and tools', async () => {
    mockApi.mockResolvedValueOnce(statsPayload);

    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', {}, ctx());

    expect(res.isError).toBeFalsy();
    expect(mockApi.mock.calls[0][0]).toBe('/api/stats/usage');
    const out = res.content[0].text;
    expect(out).toMatch(/12 task\(s\), 15 worker\(s\)/);
    expect(out).toMatch(/21\.6M in/);
    expect(out).toMatch(/\$42\.50/);
    expect(out).toMatch(/1\.4M median/);
    expect(out).toMatch(/Read: 500 \(42%\)/);
    expect(out).toMatch(/built-in: 1000/);
    expect(out).toMatch(/claude-opus-5/);
    expect(out).toMatch(/Builder: 8 task\(s\)/);
    expect(out).toMatch(/75% success/);
  });

  it('shows time-to-claim on a role group when the endpoint reports it', async () => {
    const g = { ...statsPayload.groups[0], key: 'builder · inferred', label: 'Builder · inferred', claimLatencyMs: { kind: 'value', value: { mean: 50_000, median: 42_000, p90: 180_000, max: 300_000 } } };
    mockApi.mockResolvedValueOnce({ ...statsPayload, groups: [g] });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', {}, ctx());
    expect(res.content[0].text).toMatch(/Builder · inferred: 8 task\(s\).*claimed in 42s median \/ 3m p90/);
  });

  it('states tool coverage so counts are not read as exact', async () => {
    mockApi.mockResolvedValueOnce(statsPayload);
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', {}, ctx());
    expect(res.content[0].text).toMatch(/9\/12 task\(s\) with exact counts, 2 reconstructed \(floor\), 1 unmeasured/);
  });

  it('passes window and groupBy through to the endpoint', async () => {
    mockApi.mockResolvedValueOnce(statsPayload);
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_usage_stats',
      { window: '30d', groupBy: 'workspace' },
      ctx(),
    );
    const endpoint = mockApi.mock.calls[0][0] as string;
    expect(endpoint).toContain('window=30d');
    expect(endpoint).toContain('groupBy=workspace');
  });

  // Pre-existing bug (mirrors the route-level fix): this handler used to pass
  // any string straight through to /api/stats/usage without validating it.
  it('rejects a window outside the closed set before calling the endpoint', async () => {
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', { window: 'banana' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid window "banana"/);
    expect(res.content[0].text).toMatch(/24h, 7d, 30d/);
    expect(mockApi).not.toHaveBeenCalled();
  });

  it.each(['24h', '7d', '30d'] as const)('accepts window=%s', async (window) => {
    mockApi.mockResolvedValueOnce({ ...statsPayload, window });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', { window }, ctx());
    expect(res.isError).toBeFalsy();
    expect(mockApi.mock.calls[0][0]).toContain(`window=${window}`);
  });

  it('scopes to an explicit workspace when given', async () => {
    mockApi.mockResolvedValueOnce(statsPayload);
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_usage_stats',
      { workspaceId: OTHER_WORKSPACE_ID },
      ctx(),
    );
    expect(mockApi.mock.calls[0][0]).toContain(`workspace=${OTHER_WORKSPACE_ID}`);
  });

  it('reports an empty window plainly instead of printing zeros', async () => {
    mockApi.mockResolvedValueOnce({ ...statsPayload, window: '24h', totals: { ...statsPayload.totals, tasks: 0 } });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', { window: '24h' }, ctx());
    expect(res.content[0].text).toBe('No completed work in the last 24h.');
  });

  // C23: "row cap hit — totals are a floor" was true of the totals and false of
  // the medians, which were computed over an arbitrary (unordered) subset. The
  // scan is now newest-first, so the cap notice must also say which window the
  // distributions actually cover.
  it('flags a capped scan and names the window the distributions cover', async () => {
    mockApi.mockResolvedValueOnce({
      ...statsPayload,
      truncatedScan: true,
      scan: { rows: 5000, limit: 5000, truncated: true, completeSince: '2026-08-20T00:00:00.000Z' },
    });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', {}, ctx());
    expect(res.content[0].text).toMatch(/Row cap hit \(5000\/5000\)/);
    expect(res.content[0].text).toMatch(/totals are a floor/);
    expect(res.content[0].text).toMatch(/median\/p90 below covers only since 2026-08-20T00:00:00\.000Z/);
  });

  it('omits cost entirely and names the reason on a seat-auth window', async () => {
    mockApi.mockResolvedValueOnce({
      ...statsPayload,
      totals: { ...statsPayload.totals, costUsd: 0, cacheReadTokens: 0 },
      perTask: {
        ...statsPayload.perTask,
        contributing: { ...statsPayload.perTask.contributing, costUsd: 0 },
        costUsd: {
          kind: 'unavailable',
          reason: 'No cost recorded — seat-based (OAuth) accounts report no per-task cost',
        },
      },
    });

    const out = (await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', {}, ctx()))
      .content[0].text;
    expect(out).not.toMatch(/\$0\.00/);
    expect(out).toMatch(/seat-based \(OAuth\) accounts report no per-task cost/);
    // Tokens are unaffected by cost being absent.
    expect(out).toMatch(/1\.4M median/);
  });

  it('shows the sample size when a median covers only some tasks', async () => {
    mockApi.mockResolvedValueOnce(statsPayload);
    const out = (await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', {}, ctx()))
      .content[0].text;
    // 10 of 12 tasks recorded input tokens.
    expect(out).toMatch(/\[n=10\/12\]/);
  });

  it('prints a dash, not a zero, when no task recorded tokens', async () => {
    mockApi.mockResolvedValueOnce({
      ...statsPayload,
      perTask: {
        ...statsPayload.perTask,
        contributing: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, toolCalls: 0 },
        inputTokens: { kind: 'unavailable', reason: 'No task in this window recorded input tokens' },
      },
    });

    const out = (await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', {}, ctx()))
      .content[0].text;
    expect(out).toMatch(/input — \(No task in this window recorded input tokens\)/);
  });

  it('explains an empty model split rather than leaving it silently absent', async () => {
    mockApi.mockResolvedValueOnce({ ...statsPayload, byModel: [] });
    const out = (await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', {}, ctx()))
      .content[0].text;
    expect(out).toMatch(/By model: unavailable — the SDK reports no per-model usage on seat-based \(OAuth\) auth/);
  });

  it('marks a role group that recorded no tokens instead of showing 0', async () => {
    mockApi.mockResolvedValueOnce({
      ...statsPayload,
      groups: [{
        ...statsPayload.groups[0],
        perTask: {
          ...statsPayload.groups[0].perTask,
          inputTokens: { kind: 'unavailable', reason: 'No task in this window recorded input tokens' },
          costUsd: { kind: 'unavailable', reason: 'No cost recorded' },
        },
      }],
    });

    const out = (await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', {}, ctx()))
      .content[0].text;
    expect(out).toMatch(/Builder: 8 task\(s\) · 6 completed · no tokens recorded · 75% success/);
  });

  it('splits interactive MCP sessions from runners with groupBy=executor, with completed counts', async () => {
    mockApi.mockResolvedValueOnce({
      ...statsPayload,
      groupBy: 'executor',
      groups: [
        { ...statsPayload.groups[0], key: 'runner', label: 'Runner', tasks: 9, completed: 7, failed: 1, successRate: 0.875 },
        { ...statsPayload.groups[0], key: 'interactive', label: 'Interactive (MCP session)', tasks: 3, completed: 2, failed: 0, successRate: 1 },
      ],
    });
    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_usage_stats',
      { groupBy: 'executor' },
      ctx(),
    );
    expect(mockApi.mock.calls[0][0]).toContain('groupBy=executor');
    const out = res.content[0].text;
    expect(out).toMatch(/By executor:/);
    expect(out).toMatch(/Runner: 9 task\(s\) · 7 completed/);
    expect(out).toMatch(/Interactive \(MCP session\): 3 task\(s\) · 2 completed/);
  });

  it('documents groupBy=executor in the params description', () => {
    expect(buildParamsDescription(['get_usage_stats'])).toContain('"executor"');
  });

  it('does not crash when a group has no terminal tasks yet', async () => {
    mockApi.mockResolvedValueOnce({
      ...statsPayload,
      groups: [{ ...statsPayload.groups[0], completed: 0, failed: 0, successRate: null }],
    });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', {}, ctx());
    expect(res.content[0].text).toMatch(/n\/a success/);
  });
});

describe('get_usage_stats — fine-grained breakdowns', () => {
  const breakdowns = {
    bashBuckets: {
      histogramTasks: 9, classifiedTasks: 8, bashCalls: 400, classifiedCalls: 360,
      buckets: [
        { key: 'code_search', calls: 180, share: 0.5 },
        { key: 'test', calls: 120, share: 1 / 3 },
        { key: 'git', calls: 60, share: 1 / 6 },
        { key: 'gh', calls: 0, share: 0 },
      ],
    },
    searchShapes: {
      codeSearchCalls: 180,
      shapes: [
        { key: 'identifier', calls: 90, share: 0.5 },
        { key: 'regex', calls: 90, share: 0.5 },
        { key: 'unknown', calls: 0, share: 0 },
      ],
    },
    buildActions: {
      actions: [
        { action: 'update_progress', calls: 30, share: 75 },
        { action: 'recall', calls: 10, share: 25 },
      ],
      totalCalls: 40, workersWithEvents: 6, workers: 15, capturedSince: '2026-09-03',
      windowPredatesCapture: false, truncated: false,
    },
    cbmTools: {
      sessions: 7, totalCalls: 20,
      tools: [{ tool: 'search_graph', calls: 20, sessions: 5, share: 1 }],
    },
  };

  const run = async (payload: any) => {
    const api = mock();
    api.mockResolvedValueOnce(payload);
    const res = await handleBuilddAction(api as unknown as ApiFn, 'get_usage_stats', {}, ctx());
    return res.content[0].text as string;
  };

  it('lists every tool, not a top slice', async () => {
    const byTool = Array.from({ length: 14 }, (_, i) => ({ name: `Tool${i}`, calls: 20 - i, share: 0.01, tasks: 1 }));
    const out = await run({ ...statsPayload, tools: { ...statsPayload.tools, byTool } });
    expect(out).toContain('Tools (all 14):');
    expect(out).toContain('Tool13: 7');
  });

  it('renders Bash buckets and search shapes over the exact-histogram population', async () => {
    const out = await run({ ...statsPayload, ...breakdowns });
    expect(out).toMatch(/code_search: 180 \(50%\)/);
    expect(out).toMatch(/gh: 0 \(0%\)/);
    expect(out).toMatch(/360\/400 Bash calls classified, over 9 task\(s\) with an exact histogram only; no cross-window delta/);
    expect(out).toMatch(/Search shapes \(of 180 code_search call\(s\); identifier = answerable by a structural index\)/);
    expect(out).toMatch(/identifier: 90 \(50%\)/);
  });

  it('renders the buildd action list with its recorded-since coverage', async () => {
    const out = await run({ ...statsPayload, ...breakdowns });
    expect(out).toMatch(/buildd actions \(40 call\(s\)\):/);
    expect(out).toMatch(/update_progress: 30 \(75%\)/);
    expect(out).toMatch(/6\/15 worker\(s\) recorded; actions recorded since 2026-09-03, no backfill/);
  });

  it('renders codebase-graph tools as session-keyed', async () => {
    const out = await run({ ...statsPayload, ...breakdowns });
    expect(out).toMatch(/search_graph: 20 \(100%\) in 5 session\(s\)/);
    expect(out).toMatch(/over 7 CBM-enabled completed worker session\(s\); session-keyed/);
  });

  it('says why a breakdown is missing instead of dropping it', async () => {
    const out = await run({
      ...statsPayload,
      bashBuckets: { histogramTasks: 3, classifiedTasks: 0, bashCalls: 12, classifiedCalls: 0, buckets: [] },
      searchShapes: { codeSearchCalls: 0, shapes: [] },
      buildActions: { ...breakdowns.buildActions, actions: [], totalCalls: 0, windowPredatesCapture: true },
      cbmTools: null,
    });
    expect(out).toMatch(/Bash buckets: none classified/);
    expect(out).toMatch(/buildd actions: none recorded in this window/);
    expect(out).toMatch(/may mean not yet recorded/);
    expect(out).toMatch(/Codebase-graph tools: no completed session in this window had the graph available/);
  });

  it('documents the breakdowns in the action description', () => {
    const desc = buildParamsDescription(['get_usage_stats']);
    expect(desc).toMatch(/Bash intent buckets and code-search shapes/);
  });
});
