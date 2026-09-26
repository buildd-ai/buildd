/**
 * Structured `action` milestones for tool calls.
 *
 * The web task page renders a tool-call tape and a "Touched files" list with
 * per-file diff bars from these fields. `label` stays exactly as it always was
 * (older dashboards read only that); everything else is additive.
 *
 * Pure helpers only — workers.ts calls them from handleMessage/addMilestone.
 */

import type { Milestone } from './types';

export type ActionTool = 'Edit' | 'Write' | 'MultiEdit' | 'Read' | 'Bash';
export type ActionMilestone = Extract<Milestone, { type: 'action' }>;

/** Total milestones kept per worker. */
export const MILESTONE_CAP = 100;
/** Max length of the `cmd` field before truncation. */
export const BASH_CMD_MAX = 80;

function splitLines(s: string): string[] {
  if (!s) return [];
  const lines = s.split('\n');
  // A trailing newline terminates the last line; it does not start a new one.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function countLines(s: unknown): number {
  return typeof s === 'string' ? splitLines(s).length : 0;
}

/**
 * Multiset line diff: a line present in `next` but not matched by an equal
 * line in `prev` is an add; any unmatched `prev` line is a removal. Order is
 * ignored — cheap, dependency-free, and exact for the common edit shapes.
 */
export function lineDiff(prev: unknown, next: unknown): { add: number; rem: number } {
  const oldLines = typeof prev === 'string' ? splitLines(prev) : [];
  const newLines = typeof next === 'string' ? splitLines(next) : [];
  const pool = new Map<string, number>();
  for (const l of oldLines) pool.set(l, (pool.get(l) ?? 0) + 1);
  let add = 0;
  for (const l of newLines) {
    const n = pool.get(l) ?? 0;
    if (n > 0) pool.set(l, n - 1);
    else add++;
  }
  let rem = 0;
  for (const n of pool.values()) rem += n;
  return { add, rem };
}

/** Strip `root` from `p` when `p` is under it; otherwise return `p` unchanged. */
export function relativizePath(p: string, root?: string | null): string {
  if (!root) return p;
  const base = root.replace(/\/+$/, '');
  if (!base) return p;
  if (p.startsWith(base + '/')) {
    const rel = p.slice(base.length).replace(/^\/+/, '');
    return rel || p;
  }
  return p;
}

function basename(p: string): string {
  return p.split('/').pop() || p;
}

// Substrings the original filter matched on — kept verbatim for back-compat.
const LEGACY_NOTABLE = ['git commit', 'npm', 'bun', 'test', 'build'];
// Additional toolchain commands, matched as whole words.
const NOTABLE_WORDS = /(^|[\s;&|(/])(pnpm|yarn|npx|pytest|cargo|make|tsc|vitest|jest|tox|gradle|mvn|go\s+(test|build|vet)|git\s+push|gh\s+pr)(?=$|[\s;&|)])/;

/** Whether a Bash command is worth a milestone (vs. ls/cat/grep noise). */
export function isNotableBash(cmd: string): boolean {
  if (!cmd) return false;
  if (LEGACY_NOTABLE.some(k => cmd.includes(k))) return true;
  return NOTABLE_WORDS.test(cmd);
}

export function truncateCmd(cmd: string, max = BASH_CMD_MAX): string {
  const oneLine = cmd.trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/**
 * Build the action milestone for a tool call, or null when the call is not
 * milestone-worthy. `root` is the worker's session cwd (worktree), used to
 * make paths repo-relative.
 */
export function toolActionMilestone(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  root: string | null | undefined,
  ts: number = Date.now(),
): ActionMilestone | null {
  const inp = input ?? {};
  const rawPath = typeof inp.file_path === 'string' ? inp.file_path : '';
  const path = rawPath ? relativizePath(rawPath, root) : undefined;
  const short = rawPath ? basename(rawPath) : 'file';

  switch (toolName) {
    case 'Edit': {
      const { add, rem } = lineDiff(inp.old_string, inp.new_string);
      return { type: 'action', label: `Edited ${short}`, ts, tool: 'Edit', ...(path ? { path } : {}), add, rem };
    }
    case 'MultiEdit': {
      const edits = Array.isArray(inp.edits) ? inp.edits as Array<Record<string, unknown>> : [];
      let add = 0, rem = 0;
      for (const e of edits) {
        const d = lineDiff(e?.old_string, e?.new_string);
        add += d.add;
        rem += d.rem;
      }
      return { type: 'action', label: `Edited ${short}`, ts, tool: 'MultiEdit', ...(path ? { path } : {}), add, rem };
    }
    case 'Write':
      return { type: 'action', label: `Wrote ${short}`, ts, tool: 'Write', ...(path ? { path } : {}), add: countLines(inp.content), rem: 0 };
    case 'Read':
      return { type: 'action', label: `Read ${short}`, ts, tool: 'Read', ...(path ? { path } : {}), count: 1 };
    case 'Bash': {
      const cmd = typeof inp.command === 'string' ? inp.command : '';
      if (!isNotableBash(cmd)) return null;
      return { type: 'action', label: `Ran: ${cmd.slice(0, 50)}`, ts, tool: 'Bash', cmd: truncateCmd(cmd) };
    }
    default:
      return null;
  }
}

const isReadAction = (m: Milestone) => m.type === 'action' && m.tool === 'Read';

/**
 * Append `milestone` to `list` in place, applying Read compaction and the cap.
 *
 * - A Read of the same path as the immediately previous milestone (also a
 *   Read) folds into it: its `count` is bumped and `ts` refreshed. Returns
 *   `{ folded: true }` and nothing is appended.
 * - Over `cap`: drop the oldest Read action first, then the oldest other
 *   action, then the oldest milestone of any type.
 */
export function appendMilestone(list: Milestone[], milestone: Milestone, cap = MILESTONE_CAP): { folded: boolean } {
  const prev = list[list.length - 1];
  if (
    prev && isReadAction(prev) && isReadAction(milestone)
    && prev.type === 'action' && milestone.type === 'action'
    && prev.path !== undefined && prev.path === milestone.path
  ) {
    list[list.length - 1] = { ...prev, count: (prev.count ?? 1) + (milestone.count ?? 1), ts: milestone.ts };
    return { folded: true };
  }

  list.push(milestone);
  while (list.length > cap) {
    let idx = list.findIndex(isReadAction);
    if (idx < 0) idx = list.findIndex(m => m.type === 'action');
    if (idx < 0) idx = 0;
    list.splice(idx, 1);
  }
  return { folded: false };
}
