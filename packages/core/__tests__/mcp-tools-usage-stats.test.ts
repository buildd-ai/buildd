import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, workerActions, type ApiFn, type ActionContext } from '../mcp-tools';

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
    inputTokens: { mean: 1_800_000, median: 1_400_000, p90: 3_200_000, max: 4_000_000 },
    outputTokens: { mean: 20_000, median: 18_000, p90: 30_000, max: 40_000 },
    costUsd: { mean: 3.54, median: 2.1, p90: 8.0, max: 10.0 },
    turns: { mean: 25, median: 22, p90: 40, max: 60 },
    toolCalls: { mean: 100, median: 85, p90: 190, max: 240 },
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
        inputTokens: { mean: 2_250_000, median: 2_000_000, p90: 3_200_000, max: 4_000_000 },
        outputTokens: { mean: 25_000, median: 22_000, p90: 30_000, max: 40_000 },
        costUsd: { mean: 4.5, median: 3.2, p90: 8, max: 10 },
        turns: { mean: 30, median: 28, p90: 40, max: 60 },
        toolCalls: { mean: 125, median: 110, p90: 190, max: 240 },
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

  it('flags a capped scan so totals are not read as complete', async () => {
    mockApi.mockResolvedValueOnce({ ...statsPayload, truncatedScan: true });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'get_usage_stats', {}, ctx());
    expect(res.content[0].text).toMatch(/row cap hit/);
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
