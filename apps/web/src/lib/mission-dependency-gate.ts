// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * Has an upstream mission met a downstream mission's gate? Pure: the loader in
 * `mission-dependency.ts` reads the rows, this decides and names what is left.
 *
 * Two gates (docs/specs/mission-task-lifecycle.md, "Mission dependencies"):
 *
 *  - `completed`: the upstream mission is completed. Its status is written only
 *    by the completion predicate (`canCompleteMission`) or a person's override,
 *    so the status is the predicate's answer and is not re-derived here.
 *  - `merged`: the upstream's work has shipped. Read from PR state only, never
 *    from goal criteria or the visual review: a verification that went stale
 *    after the merge does not un-merge anything.
 *
 * A completed upstream meets both gates: completion already required every
 * deliverable PR shipped and, on a mission branch, the mission PR merged.
 *
 * The `merged` gate is shut by:
 *  1. an unfinished build or repair task (its PR is still to come);
 *  2. a build or repair task whose latest PR has not shipped: open, or closed
 *     without merging and with no supersession or abandonment recorded. Same
 *     predicate as completion (`prShipState`), lineage-derived supersession and
 *     the kernel's delivery state included;
 *  3. any other row still holding an open PR (a retry attempt's own PR);
 *  4. on a mission branch that carried work: the mission PR not merged;
 *  5. nothing shipped yet. An active upstream with no merged work (no tasks
 *     filed yet, or all of it cancelled) has not merged anything: only its
 *     completion releases a dependent then.
 *
 * Verification (`[surface audit]`, final verification) and maintenance (a trunk
 * refresh of the integration branch) never hold it: neither carries the work.
 * A refresh closed as obsolete is not an unshipped deliverable.
 */
import { isTerminalTaskStatus } from '@buildd/shared';
import { deliverableRole, isDeliverableTask } from '@buildd/core/mission-helpers';
import { isMissionPrTask } from '@buildd/core/mission-integration';
import { deriveLineageSupersession, prNumberOf, prShipState, type LineageWorker, type PrShipState } from '@buildd/core/pr-shipped';

export type GateCondition = 'merged' | 'completed';

export interface GateUpstream {
  title: string;
  status: string;
  /** The mission delivers through an integration branch (`missionIntegrationBase` is non-null). */
  integrationBranch: boolean;
}

export interface GateTask {
  id: string;
  title: string | null;
  status: string;
  taskClass: string | null;
  parentTaskId?: string | null;
  mode?: string | null;
  kind?: string | null;
  category?: string | null;
  creationSource?: string | null;
  roleSlug?: string | null;
  context?: unknown;
  /** The task's latest worker, already overlaid with its kernel delivery (`withDeliveryShip`). */
  worker: (LineageWorker & { taskId?: string | null }) | null;
}

export type UnmetCondition =
  | { kind: 'upstream_not_completed'; status: string }
  | { kind: 'task_open'; taskId: string; title: string; status: string }
  | { kind: 'pr_open'; taskId: string; title: string; prNumber: number | null }
  | { kind: 'pr_closed_unmerged'; taskId: string; title: string; prNumber: number | null }
  | { kind: 'mission_pr_unmerged'; taskId: string | null; prNumber: number | null }
  | { kind: 'nothing_shipped' };

export interface GateVerdict {
  met: boolean;
  unmet: UnmetCondition[];
}

const MET: GateVerdict = { met: true, unmet: [] };

/** Rows that carry the mission's work: build tasks and the fixes filed against them. */
function carriesWork(t: GateTask): boolean {
  if (!isDeliverableTask(t)) return false;
  const role = deliverableRole(t);
  return role === 'build' || role === 'repair';
}

/** Rows the gate ignores entirely: verification and maintenance, and their retry attempts. */
function ignored(t: GateTask, byId: Map<string, GateTask>): boolean {
  let row: GateTask | undefined = t;
  for (let i = 0; row && i < 10; i++) {
    const role = deliverableRole(row);
    if (role === 'verification' || role === 'maintenance') return true;
    row = row.parentTaskId ? byId.get(row.parentTaskId) : undefined;
  }
  return false;
}

export function evaluateUpstreamGate(
  gate: GateCondition,
  upstream: GateUpstream,
  tasks: readonly GateTask[],
): GateVerdict {
  if (upstream.status === 'completed') return MET;
  if (gate === 'completed') return { met: false, unmet: [{ kind: 'upstream_not_completed', status: upstream.status }] };

  const byId = new Map(tasks.map(t => [t.id, t]));
  const workers = deriveLineageSupersession(
    tasks,
    tasks.flatMap(t => (t.worker ? [{ ...t.worker, taskId: t.id }] : [])),
  );
  const workerOf = new Map(workers.map(w => [w.taskId as string, w]));
  // One PR, one answer: a retry attempt usually carries its parent's PR, and a
  // merge stamped on one of those rows settles the PR for every row naming it.
  const settledByUrl = new Map<string, PrShipState>();
  for (const w of workers) {
    const s = prShipState(w);
    if (w.prUrl && (s === 'merged' || s === 'superseded' || s === 'abandoned') && !settledByUrl.has(w.prUrl)) settledByUrl.set(w.prUrl, s);
  }
  const shipOf = (w: LineageWorker | null | undefined): PrShipState =>
    (w?.prUrl ? settledByUrl.get(w.prUrl) : undefined) ?? prShipState(w);
  const unmet: UnmetCondition[] = [];
  const title = (t: GateTask) => t.title ?? t.id;

  let workShipped = false;
  for (const t of tasks) {
    if (ignored(t, byId)) continue;
    if (isMissionPrTask(t)) continue;
    const w = workerOf.get(t.id) ?? null;
    const ship = shipOf(w);
    const prNumber = w ? prNumberOf(w) : null;
    if (carriesWork(t)) {
      if (!isTerminalTaskStatus(t.status)) {
        unmet.push({ kind: 'task_open', taskId: t.id, title: title(t), status: t.status });
        continue;
      }
      if (ship === 'open') unmet.push({ kind: 'pr_open', taskId: t.id, title: title(t), prNumber });
      else if (ship === 'closed_unsuperseded') unmet.push({ kind: 'pr_closed_unmerged', taskId: t.id, title: title(t), prNumber });
      else if (ship === 'merged' || ship === 'superseded') workShipped = true;
    } else if (ship === 'open') {
      unmet.push({ kind: 'pr_open', taskId: t.id, title: title(t), prNumber });
    }
  }

  if (upstream.integrationBranch && workShipped) {
    const missionPrRows = tasks.filter(isMissionPrTask);
    const merged = missionPrRows.some(t => shipOf(workerOf.get(t.id)) === 'merged');
    if (!merged) {
      const open = missionPrRows.find(t => shipOf(workerOf.get(t.id)) === 'open') ?? null;
      const w = open ? workerOf.get(open.id) ?? null : null;
      unmet.push({ kind: 'mission_pr_unmerged', taskId: open?.id ?? null, prNumber: w ? prNumberOf(w) : null });
    }
  }

  if (!workShipped && unmet.length === 0) unmet.push({ kind: 'nothing_shipped' });
  return unmet.length === 0 ? MET : { met: false, unmet };
}

const pr = (n: number | null) => (n ? `PR #${n}` : 'its PR');

/** One unmet condition in a sentence, naming the task and PR. */
export function describeUnmetCondition(u: UnmetCondition): string {
  switch (u.kind) {
    case 'upstream_not_completed': return `it is ${u.status}, not completed`;
    case 'task_open': return `"${u.title}" is ${u.status.replace(/_/g, ' ')}`;
    case 'pr_open': return `${pr(u.prNumber)} for "${u.title}" is not merged`;
    case 'pr_closed_unmerged': return `${pr(u.prNumber)} for "${u.title}" closed without merging, and no replacement PR or abandonment is recorded`;
    case 'mission_pr_unmerged': return u.prNumber ? `the mission PR #${u.prNumber} is not merged` : 'the mission PR has not been opened';
    case 'nothing_shipped': return 'none of its work has merged yet';
  }
}

/** The blocked line a downstream mission shows: the gate, then the first condition left, then how many more. */
export function gateBlockedReason(upstreamTitle: string, gate: GateCondition, unmet: readonly UnmetCondition[]): string {
  const head = gate === 'completed'
    ? `Waiting for mission "${upstreamTitle}" to complete`
    : `Waiting for mission "${upstreamTitle}" PRs to merge`;
  if (unmet.length === 0) return head;
  const more = unmet.length > 1 ? ` (and ${unmet.length - 1} more)` : '';
  return `${head}: ${describeUnmetCondition(unmet[0])}${more}`;
}
