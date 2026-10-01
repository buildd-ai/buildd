/**
 * Outcome labels for orchestration decisions — the pure join
 * (docs/design/conflict-aware-orchestration.md §5a/§5b labelling, §6).
 *
 * A decision row is graded against what actually happened to its task:
 *
 *  - **touched**: the files the task's worker sessions actually touched,
 *    persisted at terminal status before `workers.observed_touches` is cleared
 *    (`orchestration_touch_labels`), flagged `landed` when the task's PR merged
 *    and `failed` when the task failed — observed edits, landed edits and
 *    failed work stay distinguishable.
 *  - **conflictCreated**: a conflict-retry task filed for the task's PR.
 *  - **collision**: a `path_claim` deferral where the task was blocked, or was
 *    the blocker.
 *  - **mergeBaseRefusal**: a `merge_base_freshness` refusal of the task's PR.
 *  - **risk**: the composite.
 *
 * All joins are by workspace + task/PR (+ head and base when the decision
 * pinned them) and only count events at or after the decision.
 *
 * Every label is one of four states, and a readout must treat them
 * differently: `observed` (a value), `censored` (the window has not closed or
 * never opened — a held, still-open or cancelled task; an open PR), `missing`
 * (the window closed but the data is absent — no persisted observation, a
 * deleted task) and `not_applicable` (no PR, so there is no PR outcome). A
 * held or cancelled task is censored, never a safe start.
 *
 * Joins only data that exists without any later step: `gate_events`, `tasks`
 * (conflict-retry columns), `workers` and the touch labels. Pure: the stores
 * live in `./orchestration-ledger-source.ts`.
 */
import { REPO_WIDE_SENTINEL } from './path-overlap';

/** `workers.observed_touches` is capped at this many paths; a label at the cap may be partial. */
export const OBSERVED_TOUCHES_CAP = 500;

export const COLLISION_GATE = 'path_claim';
export const MERGE_BASE_GATE = 'merge_base_freshness';

export interface DecisionForJoin {
  id: string;
  taskId: string | null;
  workspaceId: string;
  prNumber: number | null;
  headSha: string | null;
  baseRef: string | null;
  createdAt: Date;
}

export interface TaskForJoin {
  id: string;
  workspaceId: string;
  status: string;
}

export interface TouchLabelForJoin {
  taskId: string;
  workerId: string | null;
  workerStatus: string;
  touchedPaths: string[];
  truncated: boolean;
  prNumber: number | null;
  headSha: string | null;
  baseRef: string | null;
  recordedAt: Date;
}

export interface PrForJoin {
  taskId: string;
  workspaceId: string;
  prNumber: number;
  headSha: string | null;
  baseRef: string | null;
  mergedAt: Date | null;
  lifecycle: string | null;
}

export interface ConflictTaskForJoin {
  id: string;
  workspaceId: string;
  prNumber: number;
  headSha: string | null;
  createdAt: Date;
}

export interface GateEventForJoin {
  gate: string;
  outcome: string;
  workspaceId: string | null;
  taskId: string | null;
  occurredAt: Date;
  detail: Record<string, unknown> | null;
}

export interface OutcomeJoinInput {
  decisions: DecisionForJoin[];
  tasks: TaskForJoin[];
  labels: TouchLabelForJoin[];
  prs: PrForJoin[];
  conflictTasks: ConflictTaskForJoin[];
  gateEvents: GateEventForJoin[];
}

export type CensorReason = 'open' | 'cancelled' | 'pr_open';
export type MissingReason = 'no_task' | 'task_not_found' | 'no_terminal_observation';

export type Censored = { status: 'censored'; reason: CensorReason };
export type Missing = { status: 'missing'; reason: MissingReason };
export type NotApplicable = { status: 'not_applicable'; reason: 'no_pr' };

export type JoinKey = 'pr' | 'pr_head';

export interface TouchedValue {
  paths: string[];
  landed: boolean;
  failed: boolean;
  truncated: boolean;
}

export interface DecisionOutcomeLabels {
  decisionId: string;
  task: { status: 'observed'; value: string } | Censored | Missing;
  touched: { status: 'observed'; value: TouchedValue } | Censored | Missing;
  conflictCreated: { status: 'observed'; value: boolean; count: number; joinKey: JoinKey } | Censored | Missing | NotApplicable;
  collision: { status: 'observed'; value: boolean; count: number } | Censored | Missing;
  mergeBaseRefusal: { status: 'observed'; value: boolean; count: number; joinKey: JoinKey } | Censored | Missing | NotApplicable;
  risk: { status: 'observed'; value: boolean } | Censored | Missing;
}

/** Normalise a terminal observation into a label: deduped, no blanks or sentinel, cap flagged. */
export function normalizeTouchLabel(paths: readonly unknown[]): { paths: string[]; truncated: boolean } {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const t = p.trim();
    if (!t || t === REPO_WIDE_SENTINEL || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return { paths: out, truncated: paths.length >= OBSERVED_TOUCHES_CAP };
}

const PR_CLOSED = new Set(['merged', 'closed', 'unresolvable']);

const detailNum = (d: Record<string, unknown> | null, k: string): number | null => {
  const v = d?.[k];
  return typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
};
const detailStr = (d: Record<string, unknown> | null, k: string): string | null => {
  const v = d?.[k];
  return typeof v === 'string' ? v : null;
};

export function labelDecisionOutcomes(input: OutcomeJoinInput): DecisionOutcomeLabels[] {
  return input.decisions.map(d => labelOne(d, input));
}

function labelOne(d: DecisionForJoin, input: OutcomeJoinInput): DecisionOutcomeLabels {
  const allMissing = (reason: MissingReason): DecisionOutcomeLabels => {
    const m: Missing = { status: 'missing', reason };
    return { decisionId: d.id, task: m, touched: m, conflictCreated: m, collision: m, mergeBaseRefusal: m, risk: m };
  };
  if (!d.taskId) return allMissing('no_task');
  const task = input.tasks.find(t => t.id === d.taskId && t.workspaceId === d.workspaceId);
  if (!task) return allMissing('task_not_found');

  if (task.status === 'cancelled' || (task.status !== 'completed' && task.status !== 'failed')) {
    const c: Censored = { status: 'censored', reason: task.status === 'cancelled' ? 'cancelled' : 'open' };
    return { decisionId: d.id, task: c, touched: c, conflictCreated: c, collision: c, mergeBaseRefusal: c, risk: c };
  }

  const failed = task.status === 'failed';
  const since = d.createdAt.getTime();

  // PR identity: the decision's own pin wins; otherwise the task's PR (the
  // newest worker with one).
  const taskPrs = input.prs.filter(p => p.taskId === task.id && p.workspaceId === d.workspaceId);
  const prNumber = d.prNumber ?? taskPrs[taskPrs.length - 1]?.prNumber ?? null;
  const prRows = prNumber === null ? [] : taskPrs.filter(p => p.prNumber === prNumber);
  const landed = prRows.some(p => p.mergedAt !== null || p.lifecycle === 'merged');
  const prClosed = prRows.length > 0 && prRows.some(p => p.mergedAt !== null || (p.lifecycle !== null && PR_CLOSED.has(p.lifecycle)));
  const joinKey: JoinKey = d.headSha ? 'pr_head' : 'pr';

  // touched
  const labels = input.labels.filter(l => l.taskId === task.id);
  const touched: DecisionOutcomeLabels['touched'] = labels.length === 0
    ? { status: 'missing', reason: 'no_terminal_observation' }
    : {
      status: 'observed',
      value: {
        paths: [...new Set(labels.flatMap(l => l.touchedPaths))].sort(),
        landed,
        failed,
        truncated: labels.some(l => l.truncated),
      },
    };

  // collision: blocked, or the blocker
  const collisions = input.gateEvents.filter(e =>
    e.gate === COLLISION_GATE && e.outcome === 'deferred' && e.workspaceId === d.workspaceId &&
    e.occurredAt.getTime() >= since &&
    (e.taskId === task.id || detailStr(e.detail, 'blockingTaskId') === task.id));
  const collision: DecisionOutcomeLabels['collision'] = { status: 'observed', value: collisions.length > 0, count: collisions.length };

  // PR outcomes
  let conflictCreated: DecisionOutcomeLabels['conflictCreated'];
  let mergeBaseRefusal: DecisionOutcomeLabels['mergeBaseRefusal'];
  if (prNumber === null) {
    conflictCreated = { status: 'not_applicable', reason: 'no_pr' };
    mergeBaseRefusal = { status: 'not_applicable', reason: 'no_pr' };
  } else {
    const conflicts = input.conflictTasks.filter(c =>
      c.workspaceId === d.workspaceId && c.prNumber === prNumber && c.createdAt.getTime() >= since &&
      (!d.headSha || c.headSha === d.headSha));
    const refusals = input.gateEvents.filter(e =>
      e.gate === MERGE_BASE_GATE && e.outcome === 'rejected' && e.workspaceId === d.workspaceId &&
      e.occurredAt.getTime() >= since && detailNum(e.detail, 'prNumber') === prNumber &&
      (!d.headSha || detailStr(e.detail, 'headSha') === d.headSha) &&
      (!d.baseRef || detailStr(e.detail, 'baseRef') === d.baseRef));
    const anyConflict = conflicts.length > 0;
    const anyRefusal = refusals.length > 0;
    // A PR still open has an unclosed window — unless it already produced the
    // bad outcome, which no later event can undo.
    conflictCreated = !prClosed && !anyConflict
      ? { status: 'censored', reason: 'pr_open' }
      : { status: 'observed', value: anyConflict, count: conflicts.length, joinKey };
    mergeBaseRefusal = !prClosed && !anyRefusal
      ? { status: 'censored', reason: 'pr_open' }
      : { status: 'observed', value: anyRefusal, count: refusals.length, joinKey };
  }

  const parts = [conflictCreated, collision, mergeBaseRefusal];
  let risk: DecisionOutcomeLabels['risk'];
  if (parts.some(p => p.status === 'observed' && p.value === true)) risk = { status: 'observed', value: true };
  else {
    // Nothing bad observed: any still-open window keeps the composite censored.
    const censored = parts.find((p): p is Censored => p.status === 'censored');
    risk = censored ?? { status: 'observed', value: false };
  }

  return { decisionId: d.id, task: { status: 'observed', value: task.status }, touched, conflictCreated, collision, mergeBaseRefusal, risk };
}
