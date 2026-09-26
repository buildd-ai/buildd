/**
 * "Also running" is other work, not this task's own. A task's lineage — the
 * `parentTaskId` chain in both directions (the CI-fix / review attempts it
 * spawned, and the task it is itself fixing) — is the same unit of work and
 * must not be listed as a peer. Siblings (other children of the same parent,
 * e.g. sub-tasks of one plan) are genuine peers and stay.
 */

import { taskDisplayLabel } from '@buildd/core/task-label';
import { taskPageHref } from '@/lib/mission-task-href';
import type { PeerTask } from './TaskSidePanel';

interface PeerWorkerRow {
  status: string;
  milestones: unknown;
  task: { id: string; title: string; label?: string | null; missionId: string | null } | null;
}

/** Latest self-reported progress on a worker's milestone list. */
function latestPct(ms: unknown): number | null {
  const list = Array.isArray(ms) ? (ms as Array<{ type?: string; progress?: unknown }>) : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.type === 'status' && typeof m.progress === 'number') return m.progress;
  }
  return null;
}

/**
 * The side panel's "Also running" rows from the loader's live workers.
 *
 * - Same mission only, when the task has one.
 * - One row per task (a task can have several live workers).
 * - A task listed under "Unblocked by this" (`excludeTaskIds`) is not repeated
 *   here: a task appears in one side-panel list, and the dependency is the more
 *   specific relation to this task.
 * - Every row is drawn with the Board's scope + short label, so a raw
 *   "RESEARCH: …" title reads the same as a "feat(x): …" one.
 */
export function sidePanelPeers(
  rows: readonly PeerWorkerRow[],
  opts: { missionId: string | null; excludeTaskIds: ReadonlySet<string> },
): PeerTask[] {
  const seen = new Set<string>();
  const out: PeerTask[] = [];
  for (const w of rows) {
    const t = w.task;
    if (!t) continue;
    if (opts.missionId && t.missionId !== opts.missionId) continue;
    if (opts.excludeTaskIds.has(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    const { scope, label } = taskDisplayLabel({ title: t.title, label: t.label ?? null });
    out.push({
      taskId: t.id,
      scope,
      title: label,
      fullTitle: t.title,
      pct: latestPct(w.milestones),
      href: taskPageHref({ taskId: t.id, missionId: t.missionId }),
      waiting: w.status === 'waiting_input',
    });
  }
  return out;
}

/** True when `a` is `b`, an ancestor of `b`, or a descendant of `b`. */
export function isInTaskLineage(
  a: string,
  b: string,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  if (a === b) return true;
  return isAncestor(a, b, parentOf) || isAncestor(b, a, parentOf);
}

/** True when `ancestor` appears on `id`'s parent chain. Cycle-safe. */
function isAncestor(ancestor: string, id: string, parentOf: ReadonlyMap<string, string | null>): boolean {
  const seen = new Set<string>([id]);
  let cur = parentOf.get(id) ?? null;
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/** Parent ids referenced in `parentOf` whose own parent is not loaded yet. */
export function unresolvedParentIds(parentOf: ReadonlyMap<string, string | null>): string[] {
  const out = new Set<string>();
  for (const parent of parentOf.values()) {
    if (parent && !parentOf.has(parent)) out.add(parent);
  }
  return [...out];
}
