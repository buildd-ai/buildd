/**
 * The fine-grained breakdowns the runner already records, folded for display:
 * Bash intent buckets, code-search pattern shapes, and the full tool list
 * grouped by MCP server.
 *
 * Nothing here is new capture. Each block reads a field that is already
 * persisted on the worker row and states its OWN population, because the three
 * do not share one:
 *
 *  - Bash buckets / search shapes come from `resultMeta.bashCommandCounts`,
 *    which only ever rides alongside an exact tool histogram. They are stated
 *    over `coverage.histogram` tasks — never over all tasks, and with no
 *    cross-window delta (same rule as the shell panel: that population's
 *    composition moves as older workers age out).
 *  - The grouped tool list is the existing task-keyed `tools.byTool`, with its
 *    existing `≥` coverage marking.
 *
 * Pure and client-bundle safe: no db import.
 */
import type { BashCommandCounts } from '@buildd/core/db/schema';
import type { ToolEntry } from './usage-stats';

// ── Bash buckets ─────────────────────────────────────────────────────────────

/**
 * Mirrors `BASH_BUCKETS` in `apps/runner/src/bash-classify.ts`, which owns the
 * definitions (a test pins the two together). Listed so a bucket nobody hit
 * still renders as a zero row: "no test runs" is a reading, an absent row is
 * not.
 */
export const KNOWN_BASH_BUCKETS = [
  'code_search',
  'file_find',
  'test',
  'build',
  'gh',
  'git',
  'file_write',
  'file_read',
  'other',
] as const;

/** Mirrors `SEARCH_SHAPES` in `apps/runner/src/bash-classify.ts`. */
export const KNOWN_SEARCH_SHAPES = ['identifier', 'regex', 'quoted_phrase', 'path_glob', 'unknown'] as const;

/** One line of plain language per bucket, for row titles. */
export const BASH_BUCKET_HINTS: Record<string, string> = {
  code_search: 'grep / rg / ag / git grep over file contents',
  file_find: 'find / fd / tree / git ls-files: locating files by name',
  test: 'test runs',
  build: 'builds, type checks, lints, formatting, installs',
  gh: 'GitHub CLI',
  git: 'git, other than grep and ls-files',
  file_write: 'sed -i / cp / mv / rm / mkdir: changing the tree from the shell',
  file_read: 'cat / head / tail / wc / sed -n: reading a file from the shell',
  other: 'cd / echo / curl, unrecognised or unparseable commands',
};

export const SEARCH_SHAPE_HINTS: Record<string, string> = {
  identifier: 'a bare symbol name: the case a structural index could answer exactly',
  regex: 'a pattern with regex metacharacters',
  quoted_phrase: 'a quoted string containing spaces',
  path_glob: 'a path or filename glob',
  unknown: 'no pattern argument could be identified',
};

export interface CountRow {
  key: string;
  calls: number;
  /** 0–1, of the block's own total. */
  share: number;
}

/** Bash calls per task, folded across that task's workers. */
export interface TaskBashCounts {
  /** Classified calls. Always the sum of `buckets`. */
  total: number;
  buckets: Record<string, number>;
  searchShapes: Record<string, number>;
}

/** Fold one worker's counts into a task's running total, in place. */
export function addBashCounts(into: TaskBashCounts, from: BashCommandCounts | null | undefined): void {
  if (!from) return;
  for (const [bucket, n] of Object.entries(from.buckets ?? {})) {
    if (!(typeof n === 'number' && n > 0)) continue;
    into.buckets[bucket] = (into.buckets[bucket] ?? 0) + n;
    // `total` is re-derived from the buckets rather than read from the row, so
    // the invariant "buckets sum to the total" holds by construction.
    into.total += n;
  }
  for (const [shape, n] of Object.entries(from.searchShapes ?? {})) {
    if (!(typeof n === 'number' && n > 0)) continue;
    into.searchShapes[shape] = (into.searchShapes[shape] ?? 0) + n;
  }
}

export function emptyTaskBashCounts(): TaskBashCounts {
  return { total: 0, buckets: {}, searchShapes: {} };
}

export interface BashBucketsBlock {
  /** The population: tasks with an EXACT tool histogram. */
  histogramTasks: number;
  /** Of those, tasks with at least one classified Bash call. */
  classifiedTasks: number;
  /** Bash calls on the exact histogram (`toolCounts.Bash`), over the same tasks. */
  bashCalls: number;
  /**
   * Bash calls the classifier saw — the sum of `buckets`. Below `bashCalls`
   * when some workers predate the classifier: those calls are on the histogram
   * but were never bucketed, and are NOT guessed into `other`.
   */
  classifiedCalls: number;
  /** Every known bucket (zeros included) plus any unknown key, most calls first. */
  buckets: CountRow[];
}

export interface SearchShapesBlock {
  /** The `code_search` bucket — what these shapes decompose. */
  codeSearchCalls: number;
  /** Every known shape (zeros included), most calls first. Sums to `codeSearchCalls`. */
  shapes: CountRow[];
}

function rows(counts: Record<string, number>, known: readonly string[], total: number): CountRow[] {
  const keys = new Set<string>([...known, ...Object.keys(counts)]);
  return [...keys]
    .map(key => ({ key, calls: counts[key] ?? 0, share: total > 0 ? (counts[key] ?? 0) / total : 0 }))
    .sort((a, b) => b.calls - a.calls || known.indexOf(a.key) - known.indexOf(b.key) || a.key.localeCompare(b.key));
}

/**
 * Buckets and shapes over the exact-histogram population only.
 *
 * `tasks` must already be restricted to `toolSource === 'histogram'` — the
 * caller does that, so a task mixing one exact and one reconstructed worker
 * contributes to neither numerator nor denominator, exactly as on the shell
 * panel.
 */
export function buildBashBreakdown(tasks: Array<{ bash: TaskBashCounts; bashCalls: number }>): {
  bashBuckets: BashBucketsBlock;
  searchShapes: SearchShapesBlock;
} {
  const buckets: Record<string, number> = {};
  const shapes: Record<string, number> = {};
  let classifiedCalls = 0;
  let classifiedTasks = 0;
  let bashCalls = 0;
  for (const t of tasks) {
    bashCalls += t.bashCalls;
    if (t.bash.total > 0) classifiedTasks += 1;
    classifiedCalls += t.bash.total;
    for (const [k, n] of Object.entries(t.bash.buckets)) buckets[k] = (buckets[k] ?? 0) + n;
    for (const [k, n] of Object.entries(t.bash.searchShapes)) shapes[k] = (shapes[k] ?? 0) + n;
  }
  const codeSearchCalls = buckets.code_search ?? 0;
  return {
    bashBuckets: {
      histogramTasks: tasks.length,
      classifiedTasks,
      bashCalls,
      classifiedCalls,
      buckets: rows(buckets, KNOWN_BASH_BUCKETS, classifiedCalls),
    },
    searchShapes: {
      codeSearchCalls,
      shapes: rows(shapes, KNOWN_SEARCH_SHAPES, codeSearchCalls),
    },
  };
}

// ── Tools grouped by server ──────────────────────────────────────────────────

export type ToolGroupKey = 'built-in' | 'buildd' | 'other-mcp' | 'overflow';

export const TOOL_GROUP_LABELS: Record<ToolGroupKey, string> = {
  'built-in': 'Built-in',
  buildd: 'buildd',
  'other-mcp': 'Other MCP',
  overflow: 'Unattributed overflow',
};

const GROUP_ORDER: ToolGroupKey[] = ['built-in', 'buildd', 'other-mcp', 'overflow'];

export function toolGroupOf(name: string): ToolGroupKey {
  // The runner's cardinality-overflow key: real calls with no recoverable name.
  if (name === '__other__') return 'overflow';
  if (!name.startsWith('mcp__')) return 'built-in';
  const server = name.split('__')[1];
  if (server === 'buildd') return 'buildd';
  return 'other-mcp';
}

export interface ToolGroup {
  key: ToolGroupKey;
  label: string;
  calls: number;
  tools: ToolEntry[];
}

/** Every tool, grouped by server, each group most-called first. Empty groups are dropped. */
export function groupToolsByServer(tools: readonly ToolEntry[]): ToolGroup[] {
  const by = new Map<ToolGroupKey, ToolEntry[]>();
  for (const t of tools) {
    const key = toolGroupOf(t.name);
    const list = by.get(key);
    if (list) list.push(t);
    else by.set(key, [t]);
  }
  return GROUP_ORDER.filter(k => by.has(k)).map(key => {
    const list = [...by.get(key)!].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
    return { key, label: TOOL_GROUP_LABELS[key], calls: list.reduce((s, t) => s + t.calls, 0), tools: list };
  });
}

/** Rows shown before the expander on Health > Consumption. */
export const CONSUMPTION_TOP_TOOLS = 8;

export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  const pct = share * 100;
  return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}
