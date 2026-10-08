/**
 * The tool list with each tool's breakdown attached, so a row can expand in
 * place: Bash into what the commands were for, buildd into its actions, file
 * tools into the repo areas they touched. Pure: the page passes in what the
 * usage rollup and the action events already measured, and nothing is guessed
 * where a source is missing.
 */
import type { ToolEntry } from './usage-stats';
import type { BashBucketsBlock } from './usage-breakdowns';
import { BASH_BUCKET_HINTS } from './usage-breakdowns';
import { shortToolName } from './usage-drilldown';
import { LEGACY_BUILDD_ACTION_TOOL, isBuilddActionTool } from '@buildd/shared';

/**
 * The one row every buildd action tool is counted under. Sessions call the
 * group tools (`mcp__buildd__buildd_<group>`); older histograms and runners
 * that predate them carry the legacy `mcp__buildd__buildd`. Folding both under
 * the legacy name keeps the buildd row continuous across the switch, and its
 * actions breakdown (per-call events, keyed by action) already spans both.
 */
export const BUILDD_TOOL = LEGACY_BUILDD_ACTION_TOOL;

/**
 * `tools` with every buildd action tool folded into one BUILDD_TOOL row, in
 * call order. Calls and shares add. `tasks`/`exactTasks` take the largest
 * member: a task that called two of them would be counted twice by a sum, and
 * the per-task sets are not available here, so the row reports a floor.
 */
export function foldBuilddActionTools<T extends ToolEntry>(tools: readonly T[]): T[] {
  const members = tools.filter(t => isBuilddActionTool(t.name));
  if (members.length === 0 || (members.length === 1 && members[0].name === BUILDD_TOOL)) return [...tools];
  const folded = {
    ...members[0],
    name: BUILDD_TOOL,
    calls: members.reduce((a, t) => a + t.calls, 0),
    share: members.reduce((a, t) => a + t.share, 0),
    tasks: Math.max(...members.map(t => t.tasks)),
    exactCalls: members.reduce((a, t) => a + t.exactCalls, 0),
    exactTasks: Math.max(...members.map(t => t.exactTasks)),
  } as T;
  // The folded row takes its first member's place; then re-rank by calls
  // (Array.prototype.sort is stable, so ties keep the input order).
  return tools
    .flatMap(t => (t === members[0] ? [folded] : isBuilddActionTool(t.name) ? [] : [t]))
    .sort((a, b) => b.calls - a.calls);
}

/** Shell buckets that a dedicated tool already does better. */
const DEDICATED_TOOL: Record<string, string> = {
  file_read: 'Read',
  code_search: 'Grep',
  file_find: 'Glob',
};

const FILE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface ToolBreakdownInput {
  tools: readonly ToolEntry[];
  bashBuckets: BashBucketsBlock | null;
  actions: { totalCalls: number; actions: ReadonlyArray<{ action: string; calls: number }> } | null;
  fileAreas: Record<string, Record<string, number>> | null;
}

export interface BreakdownChild {
  key: string;
  label: string;
  calls: number;
  /** Of the tool's broken-down calls (0-1). */
  share: number;
  /** One line of plain language, when there is one. */
  hint?: string;
  /** A dedicated tool that does this job; the shell use is the thing to cut. */
  dedicatedTool?: string;
}

export interface ToolBreakdownRow {
  name: string;
  label: string;
  calls: number;
  share: number;
  children: BreakdownChild[];
  /** Set when the breakdown covers fewer calls than the tool row counts. */
  childCoverage: { covered: number; of: number } | null;
}

function coverage(covered: number, of: number): ToolBreakdownRow['childCoverage'] {
  return covered > 0 && covered < of ? { covered, of } : null;
}

function fromCounts(counts: Record<string, number>): BreakdownChild[] {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([key, calls]) => ({ key, label: key, calls, share: total > 0 ? calls / total : 0 }))
    .sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
}

function childrenFor(tool: ToolEntry, input: ToolBreakdownInput): Pick<ToolBreakdownRow, 'children' | 'childCoverage'> {
  if (tool.name === 'Bash' && input.bashBuckets) {
    const b = input.bashBuckets;
    const children = b.buckets
      .filter(r => r.calls > 0)
      .map(r => ({
        key: r.key,
        label: r.key.replace(/_/g, ' '),
        calls: r.calls,
        share: r.share,
        hint: BASH_BUCKET_HINTS[r.key],
        ...(DEDICATED_TOOL[r.key] ? { dedicatedTool: DEDICATED_TOOL[r.key] } : {}),
      }));
    return { children, childCoverage: coverage(b.classifiedCalls, b.bashCalls) };
  }
  if (tool.name === BUILDD_TOOL && input.actions) {
    const total = input.actions.totalCalls;
    const children = input.actions.actions
      .filter(a => a.calls > 0)
      .map(a => ({ key: a.action, label: a.action, calls: a.calls, share: total > 0 ? a.calls / total : 0 }));
    return { children, childCoverage: coverage(total, tool.calls) };
  }
  if (FILE_TOOLS.has(tool.name) && input.fileAreas?.[tool.name]) {
    const children = fromCounts(input.fileAreas[tool.name]);
    const covered = children.reduce((a, c) => a + c.calls, 0);
    return { children, childCoverage: coverage(covered, tool.calls) };
  }
  return { children: [], childCoverage: null };
}

export function buildToolBreakdown(input: ToolBreakdownInput): ToolBreakdownRow[] {
  return foldBuilddActionTools(input.tools).map(tool => ({
    name: tool.name,
    label: shortToolName(tool.name),
    calls: tool.calls,
    share: tool.share,
    ...childrenFor(tool, input),
  }));
}
