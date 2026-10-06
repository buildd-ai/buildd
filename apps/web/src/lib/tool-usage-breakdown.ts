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

export const BUILDD_TOOL = 'mcp__buildd__buildd';

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
  return input.tools.map(tool => ({
    name: tool.name,
    label: shortToolName(tool.name),
    calls: tool.calls,
    share: tool.share,
    ...childrenFor(tool, input),
  }));
}
