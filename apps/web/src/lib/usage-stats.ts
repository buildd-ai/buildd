/**
 * Usage rollups: tokens, cost, turns and tool calls per task, grouped by role,
 * workspace or model.
 *
 * The health page's existing role block counts `tasks.status` only, which says
 * whether work landed but nothing about what it cost. Everything here is
 * derived from worker rows, so it answers "what does a task from this role
 * actually consume" — the dimension role/success alone can't show.
 *
 * Pure functions: the route does the querying and access scoping, this does the
 * arithmetic, so the shape is testable without a database.
 */

import type { ResultMeta } from '@buildd/core/db/schema';

/** Max entries the runner keeps in `workers.mcpCalls` (api/workers/[id]/route.ts). */
const MCP_CALLS_CAP = 100;

/** Tool-name key the runner uses for cardinality overflow (apps/runner/src/tool-metrics.ts). */
const OTHER_TOOL_KEY = '__other__';

/** Bucket label for non-MCP (built-in) tools in the per-server rollup. */
export const BUILT_IN_SERVER = 'built-in';

/** Group key for tasks with no `roleSlug`. */
export const UNASSIGNED_ROLE = '(unassigned)';

export interface UsageWorkerRow {
  workerId: string;
  taskId: string | null;
  /**
   * Set when this worker's task is a retry attempt. Attempts are charged to the
   * parent so "tokens per task" is the cost of getting the task done, retries
   * included, rather than one cheap number per attempt.
   */
  parentTaskId?: string | null;
  workspaceId: string;
  /** Task status, used for the per-group success rate. Null when the task is gone. */
  taskStatus: string | null;
  roleSlug: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Drizzle returns `decimal` as a string. */
  costUsd: string | number | null;
  turns: number | null;
  resultMeta: ResultMeta | null;
  mcpCalls: Array<{ server: string; tool: string; ok?: boolean }> | null;
}

export interface Distribution {
  mean: number;
  median: number;
  p90: number;
  max: number;
}

/**
 * How a task's tool histogram was obtained.
 *   histogram — `resultMeta.toolCounts`: complete and exact.
 *   derived   — reconstructed from `mcpCalls` + the CBM Read/Grep/Glob counters,
 *               for workers that predate the histogram. Missing Bash/Edit/Write
 *               entirely and capped at the last 100 MCP calls, so a floor.
 *   none      — no tool signal at all.
 */
export type ToolSource = 'histogram' | 'derived' | 'none';

export interface ToolCoverage {
  tasks: number;
  histogram: number;
  derived: number;
  none: number;
  /** Share of tasks with an exact histogram (0–1). Read every `byTool` number against this. */
  histogramRate: number;
  /** Derived tasks that hit the 100-entry `mcpCalls` cap — their MCP counts are undercounts. */
  truncated: number;
}

export interface ToolEntry {
  name: string;
  calls: number;
  /** Share of all counted tool calls (0–1). */
  share: number;
  /** Number of tasks that called it at least once. */
  tasks: number;
}

export interface ServerEntry {
  server: string;
  calls: number;
  tasks: number;
}

export interface ModelEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** Share of billable (non-cache-read) input+output tokens (0–1). */
  share: number;
}

export interface MetricBlock {
  tasks: number;
  workers: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  turns: number;
  toolCalls: number;
}

export interface GroupEntry extends MetricBlock {
  key: string;
  completed: number;
  failed: number;
  /** completed / (completed + failed), or null when no task reached a terminal state. */
  successRate: number | null;
  perTask: PerTaskBlock;
}

export interface PerTaskBlock {
  inputTokens: Distribution;
  outputTokens: Distribution;
  costUsd: Distribution;
  turns: Distribution;
  /** Over tasks with a tool signal only — see `tools.coverage`. */
  toolCalls: Distribution;
}

export interface UsageStats {
  totals: MetricBlock;
  perTask: PerTaskBlock;
  tools: {
    coverage: ToolCoverage;
    byTool: ToolEntry[];
    byServer: ServerEntry[];
  };
  byModel: ModelEntry[];
  groupBy: GroupDimension;
  groups: GroupEntry[];
}

export type GroupDimension = 'role' | 'workspace' | 'none';

const ZERO_DISTRIBUTION: Distribution = { mean: 0, median: 0, p90: 0, max: 0 };

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

/** Nearest-rank percentile on an unsorted copy. `p` is 0–1. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(Math.max(rank, 1) - 1, sorted.length - 1)];
}

export function distribution(values: number[]): Distribution {
  if (values.length === 0) return { ...ZERO_DISTRIBUTION };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    mean: sum / values.length,
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: Math.max(...values),
  };
}

/** `mcp__buildd__recall` → `buildd`; anything else → `built-in`. */
export function serverOf(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return BUILT_IN_SERVER;
  const parts = toolName.split('__');
  return parts[1] || 'unknown';
}

/**
 * Tool counts for one worker, plus how they were obtained. Prefers the exact
 * histogram and falls back to the pre-histogram signals so older windows aren't
 * blank — the caller surfaces which it got via `tools.coverage`.
 */
export function toolCountsForWorker(row: UsageWorkerRow): {
  counts: Record<string, number>;
  source: ToolSource;
  truncated: boolean;
} {
  const histogram = row.resultMeta?.toolCounts;
  if (histogram && Object.keys(histogram).length > 0) {
    return { counts: { ...histogram }, source: 'histogram', truncated: false };
  }

  const counts: Record<string, number> = {};
  for (const call of row.mcpCalls ?? []) {
    const name = `mcp__${call.server}__${call.tool}`;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  const cbm = row.resultMeta?.cbm;
  if (cbm) {
    if (cbm.readCount) counts.Read = (counts.Read ?? 0) + cbm.readCount;
    if (cbm.grepCount) counts.Grep = (counts.Grep ?? 0) + cbm.grepCount;
    if (cbm.globCount) counts.Glob = (counts.Glob ?? 0) + cbm.globCount;
  }

  const mcpCallCount = row.mcpCalls?.length ?? 0;
  return {
    counts,
    source: Object.keys(counts).length > 0 ? 'derived' : 'none',
    truncated: mcpCallCount >= MCP_CALLS_CAP,
  };
}

/**
 * Cache-aware token totals from `resultMeta.modelUsage`. Returns null when the
 * SDK reported no per-model usage (always the case on seat/OAuth auth), so the
 * caller falls back to the flat `workers.inputTokens` columns.
 */
function modelUsageTotals(resultMeta: ResultMeta | null): {
  cacheReadTokens: number;
  cacheCreationTokens: number;
} | null {
  const usage = resultMeta?.modelUsage;
  if (!usage || Object.keys(usage).length === 0) return null;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const u of Object.values(usage)) {
    cacheReadTokens += num(u.cacheReadInputTokens);
    cacheCreationTokens += num(u.cacheCreationInputTokens);
  }
  return { cacheReadTokens, cacheCreationTokens };
}

interface TaskAgg {
  taskId: string;
  status: string | null;
  roleSlug: string | null;
  workspaceId: string;
  workers: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  turns: number;
  toolCalls: number;
  toolSource: ToolSource;
  counts: Record<string, number>;
  /** Workers whose derived MCP counts hit the `mcpCalls` cap. */
  truncatedWorkers: number;
}

/**
 * Fold worker rows into per-task aggregates. Workers are the unit that records
 * usage but the task is the unit people reason about, and a retried or resumed
 * task has several workers — so "tokens per task" must sum them, not average
 * over workers. Retry attempts (`parentTaskId` set) are folded into the parent
 * for the same reason. Workers with no task (`taskId` null) stand alone as their
 * own bucket so their usage isn't silently dropped.
 */
export function aggregateByTask(rows: UsageWorkerRow[]): TaskAgg[] {
  const byTask = new Map<string, TaskAgg>();

  for (const row of rows) {
    const key = row.parentTaskId ?? row.taskId ?? `worker:${row.workerId}`;
    let agg = byTask.get(key);
    if (!agg) {
      agg = {
        taskId: key,
        status: row.taskStatus,
        roleSlug: row.roleSlug,
        workspaceId: row.workspaceId,
        workers: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        turns: 0,
        toolCalls: 0,
        toolSource: 'none',
        counts: {},
        truncatedWorkers: 0,
      };
      byTask.set(key, agg);
    }

    // The canonical task's own status decides the group's outcome; an attempt's
    // 'failed' shouldn't mark a task that later succeeded on retry as failed.
    if (row.taskId === key) {
      agg.status = row.taskStatus;
      agg.roleSlug = row.roleSlug;
    }

    agg.workers++;
    agg.inputTokens += num(row.inputTokens);
    agg.outputTokens += num(row.outputTokens);
    agg.costUsd += num(row.costUsd);
    agg.turns += num(row.turns);

    const cache = modelUsageTotals(row.resultMeta);
    if (cache) {
      agg.cacheReadTokens += cache.cacheReadTokens;
      agg.cacheCreationTokens += cache.cacheCreationTokens;
    }

    const { counts, source, truncated } = toolCountsForWorker(row);
    for (const [name, n] of Object.entries(counts)) {
      agg.counts[name] = (agg.counts[name] ?? 0) + n;
      agg.toolCalls += n;
    }
    if (truncated) agg.truncatedWorkers++;
    // A task's source is the weakest of its workers' — one derived worker makes
    // the task total a floor, so 'derived' outranks 'histogram' here.
    if (source === 'derived') agg.toolSource = 'derived';
    else if (source === 'histogram' && agg.toolSource === 'none') agg.toolSource = 'histogram';
  }

  return [...byTask.values()];
}

function metricBlock(tasks: TaskAgg[]): MetricBlock {
  const block: MetricBlock = {
    tasks: tasks.length,
    workers: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    turns: 0,
    toolCalls: 0,
  };
  for (const t of tasks) {
    block.workers += t.workers;
    block.inputTokens += t.inputTokens;
    block.outputTokens += t.outputTokens;
    block.cacheReadTokens += t.cacheReadTokens;
    block.cacheCreationTokens += t.cacheCreationTokens;
    block.costUsd += t.costUsd;
    block.turns += t.turns;
    block.toolCalls += t.toolCalls;
  }
  return block;
}

function perTaskBlock(tasks: TaskAgg[]): PerTaskBlock {
  return {
    inputTokens: distribution(tasks.map(t => t.inputTokens)),
    outputTokens: distribution(tasks.map(t => t.outputTokens)),
    costUsd: distribution(tasks.map(t => t.costUsd)),
    turns: distribution(tasks.map(t => t.turns)),
    // Tasks with no tool signal would drag the median toward zero and read as
    // "agents barely use tools" when it really means "we didn't record it".
    toolCalls: distribution(tasks.filter(t => t.toolSource !== 'none').map(t => t.toolCalls)),
  };
}

function buildToolRollup(tasks: TaskAgg[]): UsageStats['tools'] {
  const callsByTool: Record<string, number> = {};
  const tasksByTool: Record<string, number> = {};
  let totalCalls = 0;

  for (const task of tasks) {
    for (const [name, n] of Object.entries(task.counts)) {
      callsByTool[name] = (callsByTool[name] ?? 0) + n;
      tasksByTool[name] = (tasksByTool[name] ?? 0) + 1;
      totalCalls += n;
    }
  }

  const byTool: ToolEntry[] = Object.entries(callsByTool)
    .map(([name, calls]) => ({
      name,
      calls,
      share: totalCalls > 0 ? calls / totalCalls : 0,
      tasks: tasksByTool[name] ?? 0,
    }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  const serverCalls: Record<string, number> = {};
  const serverTasks: Record<string, Set<string>> = {};
  for (const task of tasks) {
    for (const [name, n] of Object.entries(task.counts)) {
      // Overflow calls have no recoverable tool identity, so they can't be
      // attributed to a server — counting them anywhere would be a guess.
      if (name === OTHER_TOOL_KEY) continue;
      const server = serverOf(name);
      serverCalls[server] = (serverCalls[server] ?? 0) + n;
      (serverTasks[server] ??= new Set()).add(task.taskId);
    }
  }
  const byServer: ServerEntry[] = Object.entries(serverCalls)
    .map(([server, calls]) => ({ server, calls, tasks: serverTasks[server]?.size ?? 0 }))
    .sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server));

  const histogram = tasks.filter(t => t.toolSource === 'histogram').length;
  const derived = tasks.filter(t => t.toolSource === 'derived').length;
  const truncated = tasks.filter(t => t.truncatedWorkers > 0).length;

  return {
    coverage: {
      tasks: tasks.length,
      histogram,
      derived,
      none: tasks.length - histogram - derived,
      histogramRate: tasks.length > 0 ? histogram / tasks.length : 0,
      truncated,
    },
    byTool,
    byServer,
  };
}

function buildModelRollup(rows: UsageWorkerRow[]): ModelEntry[] {
  const acc: Record<string, Omit<ModelEntry, 'model' | 'share'>> = {};
  for (const row of rows) {
    const usage = row.resultMeta?.modelUsage;
    if (!usage) continue;
    for (const [model, u] of Object.entries(usage)) {
      const entry = (acc[model] ??= {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      });
      entry.inputTokens += num(u.inputTokens);
      entry.outputTokens += num(u.outputTokens);
      entry.cacheReadTokens += num(u.cacheReadInputTokens);
      entry.cacheCreationTokens += num(u.cacheCreationInputTokens);
      entry.costUsd += num(u.costUSD);
    }
  }

  const totalBillable = Object.values(acc).reduce((s, e) => s + e.inputTokens + e.outputTokens, 0);
  return Object.entries(acc)
    .map(([model, e]) => ({
      model,
      ...e,
      share: totalBillable > 0 ? (e.inputTokens + e.outputTokens) / totalBillable : 0,
    }))
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}

function buildGroups(tasks: TaskAgg[], groupBy: GroupDimension): GroupEntry[] {
  if (groupBy === 'none') return [];

  const buckets = new Map<string, TaskAgg[]>();
  for (const task of tasks) {
    const key = groupBy === 'role' ? (task.roleSlug ?? UNASSIGNED_ROLE) : task.workspaceId;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(task);
    else buckets.set(key, [task]);
  }

  return [...buckets.entries()]
    .map(([key, groupTasks]) => {
      const completed = groupTasks.filter(t => t.status === 'completed').length;
      const failed = groupTasks.filter(t => t.status === 'failed').length;
      const terminal = completed + failed;
      return {
        key,
        ...metricBlock(groupTasks),
        completed,
        failed,
        successRate: terminal > 0 ? completed / terminal : null,
        perTask: perTaskBlock(groupTasks),
      };
    })
    .sort((a, b) => b.inputTokens - a.inputTokens || a.key.localeCompare(b.key));
}

/** Build the full rollup from worker rows. */
export function computeUsageStats(
  rows: UsageWorkerRow[],
  groupBy: GroupDimension = 'role',
): UsageStats {
  const tasks = aggregateByTask(rows);
  return {
    totals: metricBlock(tasks),
    perTask: perTaskBlock(tasks),
    tools: buildToolRollup(tasks),
    byModel: buildModelRollup(rows),
    groupBy,
    groups: buildGroups(tasks, groupBy),
  };
}

/** Parse a window string like "24h", "7d", "30d" into milliseconds. Defaults to 7d. */
export function parseWindowMs(window: string): number {
  const match = /^(\d+)([hd])$/.exec(window);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const n = parseInt(match[1], 10);
  if (n <= 0) return 7 * 24 * 60 * 60 * 1000;
  return match[2] === 'h' ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
}
