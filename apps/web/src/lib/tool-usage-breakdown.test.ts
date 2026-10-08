import { describe, it, expect } from 'bun:test';
import { BUILDD_TOOL, buildToolBreakdown, foldBuilddActionTools, type ToolBreakdownInput } from './tool-usage-breakdown';
import { computeUsageStats, type UsageWorkerRow } from './usage-stats';

function tool(name: string, calls: number, total: number) {
  return { name, calls, share: calls / total, tasks: 1, exactCalls: calls, exactTasks: 1 };
}

function input(over: Partial<ToolBreakdownInput> = {}): ToolBreakdownInput {
  const total = 200;
  return {
    tools: [
      tool('Bash', 120, total),
      tool('mcp__buildd__buildd', 40, total),
      tool('Read', 25, total),
      tool('Edit', 10, total),
      tool('Agent', 5, total),
    ],
    bashBuckets: {
      histogramTasks: 4,
      classifiedTasks: 4,
      bashCalls: 120,
      classifiedCalls: 100,
      buckets: [
        { key: 'git', calls: 40, share: 0.4 },
        { key: 'file_read', calls: 30, share: 0.3 },
        { key: 'code_search', calls: 20, share: 0.2 },
        { key: 'test', calls: 10, share: 0.1 },
        { key: 'build', calls: 0, share: 0 },
      ],
    },
    actions: { totalCalls: 36, actions: [{ action: 'update_progress', calls: 20 }, { action: 'claim_task', calls: 16 }] },
    fileAreas: { Read: { 'apps/web': 15, docs: 10 }, Edit: { 'apps/web': 10 } },
    ...over,
  };
}

describe('buildToolBreakdown', () => {
  it('keeps the tool order and shares, and expands Bash into what the commands were for', () => {
    const rows = buildToolBreakdown(input());
    expect(rows.map(r => r.name)).toEqual(['Bash', 'mcp__buildd__buildd', 'Read', 'Edit', 'Agent']);
    const bash = rows[0];
    expect(bash.label).toBe('Bash');
    expect(bash.children.map(c => c.key)).toEqual(['git', 'file_read', 'code_search', 'test']);
    expect(bash.children[0]).toMatchObject({ label: 'git', calls: 40, share: 0.4 });
  });

  it('marks shell buckets a dedicated tool already covers', () => {
    const bash = buildToolBreakdown(input())[0];
    const by = Object.fromEntries(bash.children.map(c => [c.key, c.dedicatedTool ?? null]));
    expect(by.file_read).toBe('Read');
    expect(by.code_search).toBe('Grep');
    expect(by.git).toBeNull();
    expect(by.test).toBeNull();
  });

  it('says how much of Bash was classified when not all of it was', () => {
    const bash = buildToolBreakdown(input())[0];
    expect(bash.childCoverage).toEqual({ covered: 100, of: 120 });
    const full = buildToolBreakdown(input({ bashBuckets: { ...input().bashBuckets!, classifiedCalls: 120 } }))[0];
    expect(full.childCoverage).toBeNull();
  });

  it('expands buildd into its actions as first-class rows', () => {
    const buildd = buildToolBreakdown(input())[1];
    expect(buildd.label).toBe('buildd');
    expect(buildd.children.map(c => [c.label, c.calls])).toEqual([['update_progress', 20], ['claim_task', 16]]);
    expect(buildd.children[0].share).toBeCloseTo(20 / 36);
    expect(buildd.childCoverage).toEqual({ covered: 36, of: 40 });
  });

  it('folds the group tools into the buildd row with the legacy name, so history stays continuous', () => {
    const total = 200;
    const rows = buildToolBreakdown(input({
      tools: [
        tool('Bash', 120, total),
        tool('mcp__buildd__buildd_work', 30, total),
        tool('Read', 25, total),
        tool('mcp__buildd__buildd', 10, total),
        tool('mcp__buildd__buildd_analytics', 5, total),
        tool('mcp__buildd__recall', 4, total),
      ],
    }));
    expect(rows.map(r => [r.name, r.calls])).toEqual([
      ['Bash', 120], [BUILDD_TOOL, 45], ['Read', 25], ['mcp__buildd__recall', 4],
    ]);
    const buildd = rows[1];
    expect(buildd.label).toBe('buildd');
    expect(buildd.share).toBeCloseTo(45 / 200);
    // The actions breakdown covers every buildd tool's calls.
    expect(buildd.children.map(c => c.label)).toEqual(['update_progress', 'claim_task']);
    expect(buildd.childCoverage).toEqual({ covered: 36, of: 45 });
  });

  it('a folded row can move up past a tool it now outnumbers; tasks report a floor', () => {
    const folded = foldBuilddActionTools([
      { name: 'Read', calls: 30, share: 0.3, tasks: 4, exactCalls: 30, exactTasks: 4 },
      { name: 'mcp__buildd__buildd_work', calls: 20, share: 0.2, tasks: 3, exactCalls: 20, exactTasks: 2 },
      { name: 'mcp__buildd__buildd_tasks', calls: 15, share: 0.15, tasks: 2, exactCalls: 15, exactTasks: 2 },
    ]);
    expect(folded.map(t => [t.name, t.calls, t.tasks, t.exactCalls, t.exactTasks])).toEqual([
      [BUILDD_TOOL, 35, 3, 35, 2], ['Read', 30, 4, 30, 4],
    ]);
  });

  it('buildd_memory is not an action tool and keeps its own row', () => {
    const folded = foldBuilddActionTools([
      { name: 'mcp__buildd__buildd_memory', calls: 3, share: 0.5, tasks: 1, exactCalls: 3, exactTasks: 1 },
      { name: 'mcp__buildd__buildd_work', calls: 3, share: 0.5, tasks: 1, exactCalls: 3, exactTasks: 1 },
    ]);
    expect(folded.map(t => t.name)).toEqual(['mcp__buildd__buildd_memory', BUILDD_TOOL]);
  });

  it('expands Read and Edit into repo areas', () => {
    const rows = buildToolBreakdown(input());
    expect(rows[2].children.map(c => [c.label, c.calls])).toEqual([['apps/web', 15], ['docs', 10]]);
    expect(rows[3].children.map(c => [c.label, c.calls])).toEqual([['apps/web', 10]]);
  });

  it('a tool with nothing to break down has no children', () => {
    const agent = buildToolBreakdown(input())[4];
    expect(agent.children).toEqual([]);
    expect(agent.childCoverage).toBeNull();
  });

  it('missing breakdown sources leave rows plain, never invented', () => {
    const rows = buildToolBreakdown(input({ bashBuckets: null, actions: null, fileAreas: null }));
    for (const r of rows) expect(r.children).toEqual([]);
  });

  it('shortens MCP names for display', () => {
    const rows = buildToolBreakdown(input({
      tools: [tool('mcp__codebase-memory__search_graph', 3, 3)],
      bashBuckets: null, actions: null, fileAreas: null,
    }));
    expect(rows[0].label).toBe('search_graph');
  });
});

function row(over: Partial<UsageWorkerRow>): UsageWorkerRow {
  return {
    workerId: 'w1', taskId: 't1', parentTaskId: null, workspaceId: 'ws', roleSlug: null,
    taskStatus: 'completed', inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 1,
    resultMeta: null, mcpCalls: null,
    ...over,
  } as UsageWorkerRow;
}

describe('usage stats merge tool aliases and carry file areas', () => {
  it('bash and Bash, buildd.<x> under codex_apps and buildd, count as one tool', () => {
    const stats = computeUsageStats([
      row({ workerId: 'w1', taskId: 't1', resultMeta: { toolCounts: { Bash: 3, bash: 2, 'mcp__codex_apps__buildd.recall': 1, mcp__buildd__recall: 4 } } as any }),
    ]);
    const names = stats.tools.byTool.map(t => [t.name, t.calls]);
    expect(names).toEqual([['Bash', 5], ['mcp__buildd__recall', 5]]);
    expect(stats.tools.byTool.find(t => t.name === 'Bash')!.tasks).toBe(1);
  });

  it('sums file areas per tool over exact-histogram tasks', () => {
    const stats = computeUsageStats([
      row({ workerId: 'w1', taskId: 't1', resultMeta: { toolCounts: { Read: 3 }, fileToolAreas: { Read: { docs: 2, 'apps/web': 1 } } } as any }),
      row({ workerId: 'w2', taskId: 't2', resultMeta: { toolCounts: { Read: 1, Edit: 1 }, fileToolAreas: { Read: { docs: 1 }, Edit: { 'apps/web': 1 } } } as any }),
    ]);
    expect(stats.fileAreas.byTool).toEqual({ Read: { docs: 3, 'apps/web': 1 }, Edit: { 'apps/web': 1 } });
    expect(stats.fileAreas.tasksWithAreas).toBe(2);
  });
});
