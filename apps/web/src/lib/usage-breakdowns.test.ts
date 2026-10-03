import { describe, it, expect } from 'bun:test';
import { BASH_BUCKETS, SEARCH_SHAPES } from '../../../runner/src/bash-classify';
import {
  buildCbmToolsBlock,
  groupToolsByServer,
  KNOWN_BASH_BUCKETS,
  KNOWN_SEARCH_SHAPES,
  toolGroupOf,
  formatShare,
} from './usage-breakdowns';
import { computeUsageStats, type UsageWorkerRow } from './usage-stats';
import { buildActionBreakdownPanel } from './usage-drilldown';

const sum = (xs: Array<{ calls: number }>) => xs.reduce((s, x) => s + x.calls, 0);

const worker = (over: Partial<UsageWorkerRow> = {}): UsageWorkerRow => ({
  workerId: 'w-1',
  completedAt: new Date('2026-09-10T00:00:00Z'),
  taskId: 't-1',
  parentTaskId: null,
  workspaceId: 'ws-1',
  taskStatus: 'completed',
  roleSlug: 'builder',
  inputTokens: 1000,
  outputTokens: 100,
  costUsd: null,
  turns: 3,
  resultMeta: null,
  mcpCalls: null,
  ...over,
});

const exact = (id: string, taskId: string, bash: number, buckets: Record<string, number>, shapes: Record<string, number> = {}) =>
  worker({
    workerId: id,
    taskId,
    resultMeta: {
      toolCounts: { Bash: bash, Read: 2 },
      bashCommandCounts: { total: bash, buckets, searchShapes: shapes },
    } as any,
  });

describe('known vocabularies mirror the runner classifier', () => {
  // The web copy exists only because a client component cannot import the
  // runner. If the classifier gains a bucket, this fails until the list follows.
  it('buckets', () => expect([...KNOWN_BASH_BUCKETS]).toEqual([...BASH_BUCKETS]));
  it('search shapes', () => expect([...KNOWN_SEARCH_SHAPES]).toEqual([...SEARCH_SHAPES]));
});

describe('Bash buckets and search shapes', () => {
  const stats = computeUsageStats([
    exact('a', 't-1', 6, { code_search: 3, test: 2, git: 1 }, { identifier: 2, regex: 1 }),
    // A retry of t-1: folded into the same task.
    exact('b', 't-1', 2, { code_search: 1, build: 1 }, { path_glob: 1 }),
    exact('c', 't-2', 4, { other: 4 }),
  ]);

  it('buckets sum to the classified Bash total, which equals the histogram Bash count', () => {
    expect(sum(stats.bashBuckets.buckets)).toBe(stats.bashBuckets.classifiedCalls);
    expect(stats.bashBuckets.classifiedCalls).toBe(12);
    expect(stats.bashBuckets.bashCalls).toBe(12);
  });

  it('shapes sum to the code_search bucket', () => {
    const codeSearch = stats.bashBuckets.buckets.find(b => b.key === 'code_search')!.calls;
    expect(stats.searchShapes.codeSearchCalls).toBe(codeSearch);
    expect(sum(stats.searchShapes.shapes)).toBe(codeSearch);
  });

  it('lists every known bucket and shape, zeros included, most calls first', () => {
    expect(stats.bashBuckets.buckets.map(b => b.key).sort()).toEqual([...KNOWN_BASH_BUCKETS].sort());
    expect(stats.searchShapes.shapes.map(s => s.key).sort()).toEqual([...KNOWN_SEARCH_SHAPES].sort());
    const calls = stats.bashBuckets.buckets.map(b => b.calls);
    expect(calls).toEqual([...calls].sort((x, y) => y - x));
    expect(stats.bashBuckets.buckets.find(b => b.key === 'file_find')!.calls).toBe(0);
  });

  it('is stated over tasks with an exact histogram, never all tasks', () => {
    // A reconstructed task carries no Bash and must not enter the population,
    // and a task mixing exact + reconstructed workers drops out entirely,
    // exactly as on the shell panel.
    const s = computeUsageStats([
      exact('a', 't-1', 4, { test: 4 }),
      exact('b', 't-2', 5, { git: 5 }),
      worker({ workerId: 'c', taskId: 't-2', mcpCalls: [{ server: 'buildd', tool: 'buildd' }] }),
      worker({ workerId: 'd', taskId: 't-3', mcpCalls: [{ server: 'buildd', tool: 'buildd' }] }),
    ]);
    expect(s.tools.coverage.histogram).toBe(1);
    expect(s.bashBuckets.histogramTasks).toBe(1);
    expect(s.bashBuckets.classifiedCalls).toBe(4);
    expect(s.bashBuckets.buckets.find(b => b.key === 'git')!.calls).toBe(0);
  });

  it('counts Bash from workers older than the classifier as unclassified, not as other', () => {
    const s = computeUsageStats([
      exact('a', 't-1', 3, { test: 3 }),
      worker({ workerId: 'b', taskId: 't-2', resultMeta: { toolCounts: { Bash: 7 } } as any }),
    ]);
    expect(s.bashBuckets.bashCalls).toBe(10);
    expect(s.bashBuckets.classifiedCalls).toBe(3);
    expect(s.bashBuckets.classifiedTasks).toBe(1);
    expect(s.bashBuckets.buckets.find(b => b.key === 'other')!.calls).toBe(0);
  });

  it('is an empty breakdown, not a crash, for a window before capture', () => {
    const s = computeUsageStats([]);
    expect(s.bashBuckets.classifiedCalls).toBe(0);
    expect(s.bashBuckets.buckets.every(b => b.share === 0)).toBe(true);
    expect(s.searchShapes.codeSearchCalls).toBe(0);
  });

  it('keeps a bucket the web list does not know yet instead of dropping it', () => {
    const s = computeUsageStats([exact('a', 't-1', 2, { brand_new: 2 })]);
    expect(s.bashBuckets.buckets[0]).toMatchObject({ key: 'brand_new', calls: 2, share: 1 });
  });
});

describe('buildd actions', () => {
  it('sum to the buildd calls recorded in the window', () => {
    const rows = [
      { workerId: 'w1', action: 'update_progress' },
      { workerId: 'w1', action: 'update_progress' },
      { workerId: 'w2', action: 'recall' },
      { workerId: 'w3', action: 'create_pr' },
    ];
    const p = buildActionBreakdownPanel({ rows, workers: 5, windowStart: new Date('2026-09-10T00:00:00Z'), rowLimit: 5000 });
    expect(sum(p.actions)).toBe(rows.length);
    expect(p.totalCalls).toBe(rows.length);
    expect(p.actions.reduce((s, a) => s + a.share, 0)).toBeCloseTo(100);
  });
});

describe('codebase-graph tools', () => {
  it('lists every tool over the session population, with sessions per tool', () => {
    const block = buildCbmToolsBlock([
      { toolCalls: { search_graph: 3, trace_path: 1 } },
      { toolCalls: { search_graph: 1, get_code_snippet: 2 } },
      { toolCalls: {} },
    ]);
    expect(block.sessions).toBe(3);
    expect(block.totalCalls).toBe(7);
    expect(sum(block.tools)).toBe(block.totalCalls);
    expect(block.tools.map(t => t.tool)).toEqual(['search_graph', 'get_code_snippet', 'trace_path']);
    expect(block.tools[0]).toMatchObject({ calls: 4, sessions: 2 });
  });
});

describe('tools grouped by server', () => {
  const tool = (name: string, calls: number) => ({ name, calls, share: 0, tasks: 1, exactCalls: calls, exactTasks: 1 });
  const tools = [
    tool('Bash', 50),
    tool('mcp__buildd__buildd', 20),
    tool('Read', 30),
    tool('mcp__codebase-memory__search_graph', 4),
    tool('mcp__buildd__recall', 3),
    tool('mcp__github__get_pr', 2),
    tool('ToolSearch', 1),
    tool('__other__', 1),
  ];

  it('lists every tool exactly once', () => {
    const groups = groupToolsByServer(tools);
    const listed = groups.flatMap(g => g.tools.map(t => t.name));
    expect(listed.sort()).toEqual(tools.map(t => t.name).sort());
  });

  it('orders groups built-in, buildd, codebase-memory, other MCP, overflow', () => {
    expect(groupToolsByServer(tools).map(g => g.key)).toEqual(['built-in', 'buildd', 'codebase-memory', 'other-mcp', 'overflow']);
  });

  it('classifies by server', () => {
    expect(toolGroupOf('ToolSearch')).toBe('built-in');
    expect(toolGroupOf('mcp__buildd__recall')).toBe('buildd');
    expect(toolGroupOf('mcp__codebase-memory__trace_path')).toBe('codebase-memory');
    expect(toolGroupOf('mcp__dispatch__dispatch_read')).toBe('other-mcp');
    expect(toolGroupOf('__other__')).toBe('overflow');
  });
});

describe('formatShare', () => {
  it('never rounds a real share down to 0%', () => {
    expect(formatShare(0.001)).toBe('<1%');
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(0.456)).toBe('46%');
  });
});
