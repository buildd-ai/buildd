/**
 * Tests for usage rollups (tokens / cost / turns / tool calls per task).
 *
 * The behaviours worth pinning:
 *   - per-task means summing a task's workers, not averaging over workers
 *   - tool coverage is reported honestly (histogram vs derived vs none)
 *   - tasks with no tool signal don't get counted as "0 tool calls"
 *   - cost arrives from Drizzle as a string
 */

import { describe, test, expect } from 'bun:test';
import {
  computeUsageStats,
  measuredDistribution,
  aggregateByTask,
  toolCountsForWorker,
  distribution,
  percentile,
  serverOf,
  parseWindowMs,
  BUILT_IN_SERVER,
  UNASSIGNED_ROLE,
  type UsageWorkerRow,
} from './usage-stats';

/** Unwrap a DerivedMetric distribution, failing loudly if it is unavailable. */
function dist(m: { kind: string } & Record<string, any>) {
  if (m.kind !== 'value') throw new Error(`expected a value, got unavailable: ${m.reason}`);
  return m.value as { mean: number; median: number; p90: number; max: number };
}

function row(overrides: Partial<UsageWorkerRow> = {}): UsageWorkerRow {
  return {
    workerId: crypto.randomUUID(),
    taskId: 'task-1',
    workspaceId: 'ws-1',
    taskStatus: 'completed',
    roleSlug: 'builder',
    inputTokens: 1000,
    outputTokens: 100,
    costUsd: '0.50',
    turns: 10,
    resultMeta: null,
    mcpCalls: null,
    ...overrides,
  };
}

describe('percentile / distribution', () => {
  test('nearest-rank percentiles', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 0.9)).toBe(9);
    expect(percentile(values, 1)).toBe(10);
  });

  test('single value is its own median and p90', () => {
    expect(distribution([42])).toEqual({ mean: 42, median: 42, p90: 42, max: 42 });
  });

  test('empty input is all zeros, not NaN', () => {
    expect(distribution([])).toEqual({ mean: 0, median: 0, p90: 0, max: 0 });
  });

  test('median resists the skew that makes the mean misleading', () => {
    // Nine cheap tasks and one runaway — the reason we report both.
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 100000];
    const d = distribution(values);
    expect(d.median).toBe(10);
    expect(d.mean).toBeGreaterThan(9000);
    expect(d.max).toBe(100000);
  });
});

describe('serverOf', () => {
  test('splits the MCP server out of the tool name', () => {
    expect(serverOf('mcp__buildd__recall')).toBe('buildd');
    expect(serverOf('mcp__codebase-memory__search_code')).toBe('codebase-memory');
  });

  test('built-in tools bucket together', () => {
    expect(serverOf('Bash')).toBe(BUILT_IN_SERVER);
    expect(serverOf('Read')).toBe(BUILT_IN_SERVER);
  });

  test('tool name with an underscore-containing suffix keeps the server', () => {
    expect(serverOf('mcp__buildd__send_worker_message')).toBe('buildd');
  });
});

describe('toolCountsForWorker', () => {
  test('prefers the exact histogram', () => {
    const result = toolCountsForWorker(row({
      resultMeta: {
        stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
        toolCounts: { Bash: 12, Read: 30, 'mcp__buildd__buildd': 4 },
      },
      mcpCalls: [{ server: 'buildd', tool: 'buildd' }],
    }));
    expect(result.source).toBe('histogram');
    expect(result.counts).toEqual({ Bash: 12, Read: 30, 'mcp__buildd__buildd': 4 });
  });

  test('falls back to mcpCalls + CBM counters for pre-histogram workers', () => {
    const result = toolCountsForWorker(row({
      resultMeta: {
        stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
        cbm: {
          outcome: 'disabled', disableReason: 'binary_absent',
          toolCalls: {}, totalCbmCalls: 0, readCount: 7, grepCount: 2, globCount: 0,
        },
      },
      mcpCalls: [
        { server: 'buildd', tool: 'buildd' },
        { server: 'buildd', tool: 'buildd' },
        { server: 'buildd', tool: 'recall' },
      ],
    }));
    expect(result.source).toBe('derived');
    expect(result.counts).toEqual({
      'mcp__buildd__buildd': 2,
      'mcp__buildd__recall': 1,
      Read: 7,
      Grep: 2,
    });
    expect(result.truncated).toBe(false);
  });

  test('flags truncation when mcpCalls hit the 100-entry cap', () => {
    const calls = Array.from({ length: 100 }, () => ({ server: 'buildd', tool: 'buildd' }));
    const result = toolCountsForWorker(row({ mcpCalls: calls }));
    expect(result.truncated).toBe(true);
    expect(result.counts['mcp__buildd__buildd']).toBe(100);
  });

  test('reports none when there is no tool signal at all', () => {
    const result = toolCountsForWorker(row());
    expect(result.source).toBe('none');
    expect(result.counts).toEqual({});
  });

  test('an empty histogram object is not mistaken for coverage', () => {
    const result = toolCountsForWorker(row({
      resultMeta: {
        stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
        toolCounts: {},
      },
    }));
    expect(result.source).toBe('none');
  });
});

describe('aggregateByTask', () => {
  test('sums a retried task\'s workers into one task total', () => {
    const tasks = aggregateByTask([
      row({ taskId: 't1', inputTokens: 1000, outputTokens: 100, turns: 5, costUsd: '0.10' }),
      row({ taskId: 't1', inputTokens: 3000, outputTokens: 200, turns: 7, costUsd: '0.30' }),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].inputTokens).toBe(4000);
    expect(tasks[0].outputTokens).toBe(300);
    expect(tasks[0].turns).toBe(12);
    expect(tasks[0].costUsd).toBeCloseTo(0.4);
    expect(tasks[0].workers).toBe(2);
  });

  test('a worker with no task stands alone rather than being dropped', () => {
    const tasks = aggregateByTask([
      row({ taskId: null, workerId: 'w-orphan', inputTokens: 500 }),
      row({ taskId: null, workerId: 'w-orphan-2', inputTokens: 700 }),
    ]);
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.inputTokens).sort((a, b) => a - b)).toEqual([500, 700]);
  });

  test('one derived worker downgrades the whole task to derived', () => {
    const tasks = aggregateByTask([
      row({
        taskId: 't1',
        resultMeta: {
          stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
          toolCounts: { Bash: 5 },
        },
      }),
      row({ taskId: 't1', mcpCalls: [{ server: 'buildd', tool: 'buildd' }] }),
    ]);
    expect(tasks[0].toolSource).toBe('derived');
    expect(tasks[0].toolCalls).toBe(6);
  });

  test('folds a retry attempt into its parent task', () => {
    const tasks = aggregateByTask([
      row({ taskId: 'parent', inputTokens: 1000, taskStatus: 'completed' }),
      row({ taskId: 'attempt', parentTaskId: 'parent', inputTokens: 4000, taskStatus: 'failed' }),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].inputTokens).toBe(5000);
    // The parent's own status wins — a failed attempt of a task that later
    // succeeded must not read as a failed task.
    expect(tasks[0].status).toBe('completed');
  });

  test('an attempt whose parent is outside the window keeps its own metadata', () => {
    const tasks = aggregateByTask([
      row({ taskId: 'attempt', parentTaskId: 'parent', inputTokens: 4000, roleSlug: 'builder', taskStatus: 'failed' }),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].roleSlug).toBe('builder');
    expect(tasks[0].status).toBe('failed');
  });

  test('sums cache tokens out of per-model usage', () => {
    const tasks = aggregateByTask([
      row({
        resultMeta: {
          stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 0,
          modelUsage: {
            'claude-opus-5': {
              inputTokens: 100, outputTokens: 50,
              cacheReadInputTokens: 900_000, cacheCreationInputTokens: 12_000, costUSD: 1.5,
            },
          },
        },
      }),
    ]);
    expect(tasks[0].cacheReadTokens).toBe(900_000);
    expect(tasks[0].cacheCreationTokens).toBe(12_000);
  });
});

describe('computeUsageStats', () => {
  test('empty input produces a zeroed shape, not NaN or throw', () => {
    const stats = computeUsageStats([]);
    expect(stats.totals.tasks).toBe(0);
    expect(stats.perTask.inputTokens.kind).toBe('unavailable');
    expect(stats.perTask.tasks).toBe(0);
    expect(stats.perTask.contributing.inputTokens).toBe(0);
    expect(stats.tools.byTool).toEqual([]);
    expect(stats.tools.coverage.histogramRate).toBe(0);
    expect(stats.byModel).toEqual([]);
    expect(stats.groups).toEqual([]);
  });

  test('tool histogram ranks tools by call count with shares', () => {
    const stats = computeUsageStats([
      row({
        taskId: 't1',
        resultMeta: {
          stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
          toolCounts: { Read: 60, Bash: 30, 'mcp__buildd__buildd': 10 },
        },
      }),
    ]);
    expect(stats.tools.byTool.map(t => t.name)).toEqual(['Read', 'Bash', 'mcp__buildd__buildd']);
    expect(stats.tools.byTool[0].share).toBeCloseTo(0.6);
    expect(stats.totals.toolCalls).toBe(100);
  });

  test('per-server rollup separates MCP servers from built-ins', () => {
    const stats = computeUsageStats([
      row({
        taskId: 't1',
        resultMeta: {
          stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
          toolCounts: { Read: 10, Bash: 5, 'mcp__buildd__buildd': 4, 'mcp__codebase-memory__search_code': 3 },
        },
      }),
    ]);
    const byServer = Object.fromEntries(stats.tools.byServer.map(s => [s.server, s.calls]));
    expect(byServer[BUILT_IN_SERVER]).toBe(15);
    expect(byServer['buildd']).toBe(4);
    expect(byServer['codebase-memory']).toBe(3);
  });

  test('overflow bucket is counted in byTool but attributed to no server', () => {
    const stats = computeUsageStats([
      row({
        taskId: 't1',
        resultMeta: {
          stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
          toolCounts: { Bash: 5, __other__: 7 },
        },
      }),
    ]);
    expect(stats.totals.toolCalls).toBe(12);
    expect(stats.tools.byServer.map(s => s.server)).toEqual([BUILT_IN_SERVER]);
    expect(stats.tools.byServer[0].calls).toBe(5);
  });

  test('coverage distinguishes histogram, derived and unmeasured tasks', () => {
    const stats = computeUsageStats([
      row({
        taskId: 't1',
        resultMeta: {
          stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
          toolCounts: { Bash: 5 },
        },
      }),
      row({ taskId: 't2', mcpCalls: [{ server: 'buildd', tool: 'buildd' }] }),
      row({ taskId: 't3' }),
    ]);
    expect(stats.tools.coverage).toMatchObject({
      tasks: 3, histogram: 1, derived: 1, none: 1, truncated: 0,
    });
    expect(stats.tools.coverage.histogramRate).toBeCloseTo(1 / 3);
  });

  test('per-task tool median excludes unmeasured tasks so it is not dragged to 0', () => {
    const measured = (taskId: string, calls: number): UsageWorkerRow => row({
      taskId,
      resultMeta: {
        stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
        toolCounts: { Bash: calls },
      },
    });
    const stats = computeUsageStats([
      measured('t1', 40),
      measured('t2', 60),
      row({ taskId: 't3' }),
      row({ taskId: 't4' }),
      row({ taskId: 't5' }),
    ]);
    // Nearest-rank median over the two measured tasks only ([40, 60] → 40).
    // With the three unmeasured tasks included it would have been 0.
    expect(dist(stats.perTask.toolCalls).median).toBe(40);
    // Token distributions still cover every task — those columns are always populated.
    expect(dist(stats.perTask.inputTokens).median).toBe(1000);
  });

  test('groups by role with per-group success rate and token totals', () => {
    const stats = computeUsageStats([
      row({ taskId: 't1', roleSlug: 'builder', inputTokens: 5000, taskStatus: 'completed' }),
      row({ taskId: 't2', roleSlug: 'builder', inputTokens: 3000, taskStatus: 'failed' }),
      row({ taskId: 't3', roleSlug: 'researcher', inputTokens: 100, taskStatus: 'completed' }),
    ], 'role');

    const builder = stats.groups.find(g => g.key === 'builder')!;
    expect(builder.inputTokens).toBe(8000);
    expect(builder.tasks).toBe(2);
    expect(builder.successRate).toBeCloseTo(0.5);
    expect(dist(builder.perTask.inputTokens).max).toBe(5000);
    // Highest token consumer first — that's the ordering the health page wants.
    expect(stats.groups[0].key).toBe('builder');
  });

  test('running tasks leave successRate null instead of reading as 0%', () => {
    const stats = computeUsageStats([
      row({ taskId: 't1', roleSlug: 'builder', taskStatus: 'running' }),
    ], 'role');
    expect(stats.groups[0].successRate).toBeNull();
  });

  test('tasks with no role land in an explicit unassigned bucket', () => {
    const stats = computeUsageStats([row({ taskId: 't1', roleSlug: null })], 'role');
    expect(stats.groups[0].key).toBe(UNASSIGNED_ROLE);
  });

  test('groups by workspace when asked', () => {
    const stats = computeUsageStats([
      row({ taskId: 't1', workspaceId: 'ws-a', inputTokens: 10 }),
      row({ taskId: 't2', workspaceId: 'ws-b', inputTokens: 90 }),
    ], 'workspace');
    expect(stats.groups.map(g => g.key)).toEqual(['ws-b', 'ws-a']);
  });

  test('groupBy none skips grouping entirely', () => {
    const stats = computeUsageStats([row()], 'none');
    expect(stats.groups).toEqual([]);
    expect(stats.totals.tasks).toBe(1);
  });

  test('model rollup sums usage across workers and shares add to 1', () => {
    const usage = (model: string, input: number, output: number) => ({
      stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 0,
      modelUsage: {
        [model]: {
          inputTokens: input, outputTokens: output,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0,
        },
      },
    });
    const stats = computeUsageStats([
      row({ taskId: 't1', resultMeta: usage('claude-opus-5', 700, 100) }),
      row({ taskId: 't2', resultMeta: usage('claude-opus-5', 100, 100) }),
      row({ taskId: 't3', resultMeta: usage('claude-haiku-4-5', 100, 100) }),
    ]);
    expect(stats.byModel).toHaveLength(2);
    expect(stats.byModel[0].model).toBe('claude-opus-5');
    expect(stats.byModel[0].inputTokens).toBe(800);
    expect(stats.byModel.reduce((s, m) => s + m.share, 0)).toBeCloseTo(1);
  });

  test('null token columns count as zero rather than poisoning totals', () => {
    const stats = computeUsageStats([
      row({ taskId: 't1', inputTokens: null, outputTokens: null, turns: null, costUsd: null }),
    ]);
    expect(stats.totals.inputTokens).toBe(0);
    expect(stats.totals.costUsd).toBe(0);
    expect(stats.perTask.costUsd.kind).toBe('unavailable');
  });
});

describe('measuredDistribution', () => {
  test('excludes zeros so a half-unrecorded window is not halved', () => {
    // Five tasks, three of which never recorded a token.
    const m = measuredDistribution([0, 0, 0, 1000, 3000], 'no tokens');
    expect(m.kind).toBe('value');
    expect(dist(m).median).toBe(1000);
    expect(dist(m).mean).toBe(2000);
  });

  test('is unavailable, with the reason, when nothing recorded the metric', () => {
    const m = measuredDistribution([0, 0, 0], 'seat auth reports no cost');
    expect(m.kind).toBe('unavailable');
    expect(m.kind === 'unavailable' && m.reason).toBe('seat auth reports no cost');
  });

  test('is unavailable on an empty input rather than a zeroed distribution', () => {
    expect(measuredDistribution([], 'nothing').kind).toBe('unavailable');
  });

  test('negative values are treated as unrecorded, not as data', () => {
    expect(measuredDistribution([-5, -1], 'nothing').kind).toBe('unavailable');
  });
});

describe('zero-value tasks', () => {
  test('workers that died before recording anything do not drag the median to 0', () => {
    const stats = computeUsageStats([
      row({ taskId: 'a', inputTokens: 2_000_000, turns: 40 }),
      row({ taskId: 'b', inputTokens: 1_000_000, turns: 20 }),
      // Provision failures: terminal, but never consumed anything.
      row({ taskId: 'c', inputTokens: 0, outputTokens: 0, turns: 0, costUsd: '0' }),
      row({ taskId: 'd', inputTokens: 0, outputTokens: 0, turns: 0, costUsd: '0' }),
      row({ taskId: 'e', inputTokens: 0, outputTokens: 0, turns: 0, costUsd: '0' }),
    ]);

    expect(dist(stats.perTask.inputTokens).median).toBe(1_000_000);
    expect(stats.perTask.tasks).toBe(5);
    expect(stats.perTask.contributing.inputTokens).toBe(2);
    // Totals still count every task — a sum of zero is a true sum.
    expect(stats.totals.tasks).toBe(5);
    expect(stats.totals.inputTokens).toBe(3_000_000);
  });

  test('cost reads unavailable on a seat-auth window, never $0.00 per task', () => {
    const stats = computeUsageStats([
      row({ taskId: 'a', inputTokens: 500_000, costUsd: '0' }),
      row({ taskId: 'b', inputTokens: 700_000, costUsd: '0' }),
    ]);
    expect(stats.perTask.costUsd.kind).toBe('unavailable');
    expect(stats.perTask.costUsd.kind === 'unavailable' && stats.perTask.costUsd.reason)
      .toMatch(/seat-based/);
    // Tokens are still measured — one metric being absent doesn't sink the rest.
    expect(dist(stats.perTask.inputTokens).median).toBe(500_000);
    expect(stats.perTask.contributing.costUsd).toBe(0);
  });

  test('per-group metrics are unavailable independently of the total', () => {
    const stats = computeUsageStats([
      row({ taskId: 'a', roleSlug: 'builder', inputTokens: 900_000, costUsd: '2.00' }),
      row({ taskId: 'b', roleSlug: 'organizer', inputTokens: 0, costUsd: '0' }),
    ], 'role');

    const builder = stats.groups.find(g => g.key === 'builder')!;
    const organizer = stats.groups.find(g => g.key === 'organizer')!;
    expect(dist(builder.perTask.costUsd).median).toBeCloseTo(2);
    expect(organizer.perTask.inputTokens.kind).toBe('unavailable');
    expect(organizer.perTask.costUsd.kind).toBe('unavailable');
  });
});

describe('tool-call availability', () => {
  test('the distribution covers exactly the tasks with a tool signal', () => {
    const measured = (taskId: string, calls: Record<string, number>) => row({
      taskId,
      resultMeta: {
        stopReason: null, durationMs: 0, durationApiMs: 0, numTurns: 0, modelUsage: {},
        toolCounts: calls,
      },
    });
    const stats = computeUsageStats([
      measured('t1', { Bash: 10 }),
      measured('t2', { Bash: 20 }),
      // An empty histogram carries no signal, so it is excluded rather than
      // counted as a task that made zero calls.
      measured('t3', {}),
    ]);
    expect(stats.perTask.contributing.toolCalls).toBe(2);
    expect(dist(stats.perTask.toolCalls).median).toBe(10);
    expect(dist(stats.perTask.toolCalls).max).toBe(20);
  });

  test('tool calls are unavailable when no task carried any tool signal', () => {
    const stats = computeUsageStats([row({ taskId: 't1' }), row({ taskId: 't2' })]);
    expect(stats.perTask.toolCalls.kind).toBe('unavailable');
    expect(stats.perTask.contributing.toolCalls).toBe(0);
  });
});

describe('attempt-only task groups', () => {
  test('a completed attempt wins over a failed one regardless of row order', () => {
    const failed = row({ taskId: 'att-1', parentTaskId: 'p', taskStatus: 'failed', roleSlug: 'builder' });
    const done = row({ taskId: 'att-2', parentTaskId: 'p', taskStatus: 'completed', roleSlug: 'builder' });

    for (const ordering of [[failed, done], [done, failed]]) {
      const stats = computeUsageStats(ordering, 'role');
      expect(stats.groups[0].completed).toBe(1);
      expect(stats.groups[0].failed).toBe(0);
      expect(stats.groups[0].successRate).toBe(1);
    }
  });

  test('the canonical row still overrides a completed attempt', () => {
    const stats = computeUsageStats([
      row({ taskId: 'att-1', parentTaskId: 'p', taskStatus: 'completed' }),
      row({ taskId: 'p', taskStatus: 'failed' }),
    ], 'role');
    expect(stats.groups[0].failed).toBe(1);
  });
});

describe('parseWindowMs', () => {
  test('parses hours and days', () => {
    expect(parseWindowMs('24h')).toBe(24 * 3600_000);
    expect(parseWindowMs('7d')).toBe(7 * 24 * 3600_000);
  });

  test('defaults to 7d on garbage or zero', () => {
    const sevenDays = 7 * 24 * 3600_000;
    expect(parseWindowMs('nonsense')).toBe(sevenDays);
    expect(parseWindowMs('0d')).toBe(sevenDays);
    expect(parseWindowMs('')).toBe(sevenDays);
  });
});
