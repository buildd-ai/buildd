// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * The task page's two dependency lists, resolved for its viewer by
 * `resolveDependencyHolders` (spec e28018c2): what this task needs (R-6) and
 * what waits on it (R-9). A task the viewer cannot see is named
 * `HIDDEN_TASK_WORDS` with nothing else about it; one in another workspace
 * carries that workspace. Pure; the page does the reads.
 */
import { HIDDEN_TASK_WORDS } from './mission-task-hold';
import { taskPageHref } from './mission-task-href';
import type { DependencyHolder } from './task-dependency-reach';

export interface NeedsRow {
  id: string;
  hidden: boolean;
  title: string;
  status: string | null;
  workspaceName: string | null;
  href: string | null;
}

/** An upstream the resolver could not read is hidden, never named from the raw row. */
export function needsList(
  deps: ReadonlyArray<{ id: string; title: string; status: string }>,
  reach: ReadonlyMap<string, DependencyHolder>,
): NeedsRow[] {
  return deps.map(d => {
    const r = reach.get(d.id);
    if (!r || r.hidden) return { id: d.id, hidden: true, title: HIDDEN_TASK_WORDS, status: null, workspaceName: null, href: null };
    return { id: d.id, hidden: false, title: d.title, status: d.status, workspaceName: r.workspaceName, href: taskPageHref({ taskId: d.id }) };
  });
}

/** The dependents the viewer sees, each with its workspace when it is not this task's, and a count of the rest. */
export function blocksList<T extends { id: string }>(
  dependents: readonly T[],
  reach: ReadonlyMap<string, DependencyHolder>,
): { visible: Array<T & { workspaceName: string | null }>; hiddenCount: number } {
  const visible: Array<T & { workspaceName: string | null }> = [];
  let hiddenCount = 0;
  for (const d of dependents) {
    const r = reach.get(d.id);
    if (!r || r.hidden) hiddenCount += 1;
    else visible.push({ ...d, workspaceName: r.workspaceName });
  }
  return { visible, hiddenCount };
}

export function hiddenDependentsLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 task in a workspace you can't see waits on this" : `${n} tasks in workspaces you can't see wait on this`;
}
