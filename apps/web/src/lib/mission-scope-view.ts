/**
 * Scope updates on the mission page (docs/specs/workflow-kernel-library.md §6
 * "Scope amendments"): one short line per recorded amendment or hold, newest
 * first, so a reader sees the contract changed instead of stale prose. Pure.
 * In-scope decisions change nothing and say nothing.
 */
export interface ScopeAmendmentLike {
  sourceTaskId: string | null;
  decision: string;
  status: string;
  scopeVersionAfter: number | null;
  createdAt: string;
}

export interface ScopeUpdateLine {
  key: string;
  text: string;
  taskId: string | null;
  /** A person decides before the task can start. */
  needsDecision: boolean;
}

export const SCOPE_LINES_SHOWN = 3;

export function describeScopeUpdates(rows: ScopeAmendmentLike[], titleOf: (taskId: string) => string | null): ScopeUpdateLine[] {
  return [...rows]
    .filter((r) => r.status === 'applied' || r.status === 'held')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, SCOPE_LINES_SHOWN)
    .map((r, i) => {
      const title = r.sourceTaskId ? titleOf(r.sourceTaskId) : null;
      const named = title ? `"${title}"` : 'a task';
      return r.status === 'applied'
        ? { key: `${i}`, taskId: r.sourceTaskId, needsDecision: false, text: `Scope updated to version ${r.scopeVersionAfter ?? '?'} when ${named} was added.` }
        : { key: `${i}`, taskId: r.sourceTaskId, needsDecision: true, text: `${title ? named : 'A task'} is on hold until you decide whether it changes what this mission delivers.` };
    });
}
