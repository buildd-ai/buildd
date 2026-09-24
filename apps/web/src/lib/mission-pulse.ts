/**
 * The mission pulse: one segment per deliverable row, in a position that never
 * moves (docs/design/mission-feed-mobile-continuity.md, "The shared object").
 *
 * Pure and client-safe. This module also owns the two facts every mission-feed
 * surface must agree on — which tasks are rows at all (`foldMissionDeliverables`,
 * addendum D1) and what state a row is in (`deriveFeedTaskState`) — so the pulse,
 * the grouped list (`mission-feed-groups.ts`) and the `n / N` caption count the
 * same thing.
 */
import { isAttempt, isDeliverableTask, stripTaskTypePrefix } from '@buildd/core/mission-helpers';
import { groupTasksByPhase } from './flight-strip-nav';
import { LIVE_WORKER_STATUSES } from './task-presentation';

// ─── Input ────────────────────────────────────────────────────────────────────

/** The latest worker on a task, as far as the feed needs it. */
export interface MissionFeedWorkerInput {
  status: string;
  startedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  prLifecycleStatus?: string | null;
  mergedAt?: Date | string | null;
}

export interface MissionFeedTaskInput {
  id: string;
  title: string;
  status: string;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
  taskClass?: string | null;
  parentTaskId?: string | null;
  mode?: string | null;
  kind?: string | null;
  category?: string | null;
  creationSource?: string | null;
  dependsOn?: readonly string[] | null;
  missionPhaseIndex?: number | null;
  missionPhaseLabel?: string | null;
  /** Latest worker, or null/absent when the task never ran. */
  worker?: MissionFeedWorkerInput | null;
}

/** Facts that live outside the task row. Every field optional: absent = "none known". */
export interface MissionFeedContext {
  /** Open mission question notes, by the task they name → when asked. */
  openQuestions?: ReadonlyMap<string, Date | string>;
  /** Open `waiting_decision` gates, by the task they block → when opened. */
  openDecisions?: ReadonlyMap<string, Date | string>;
}

// ─── D1: which tasks are rows ─────────────────────────────────────────────────

export interface DeliverableRow<T extends MissionFeedTaskInput = MissionFeedTaskInput> {
  task: T;
  /** Retries, reviewer passes and superseded re-creations, oldest first. Never rows of their own. */
  attempts: T[];
}

export interface FoldedDeliverables<T extends MissionFeedTaskInput = MissionFeedTaskInput> {
  /** One per deliverable, createdAt ascending. */
  rows: DeliverableRow<T>[];
  /** Planning/bookkeeping rows, plus attempts whose parent is not in this set. */
  bookkeeping: T[];
}

const ms = (d: Date | string | null | undefined): number => (d == null ? NaN : new Date(d).getTime());
const byCreated = (a: MissionFeedTaskInput, b: MissionFeedTaskInput) =>
  ms(a.createdAt) - ms(b.createdAt) || a.id.localeCompare(b.id);

const normTitle = (title: string) => stripTaskTypePrefix(title).trim().toLowerCase();
const SUPERSEDABLE = new Set(['cancelled', 'failed']);

/**
 * Addendum D1: retries and cancelled re-creations fold under their parent, so
 * the rows shown equal the deliverables counted.
 *
 * - `attempt` rows (`taskClass`) attach to `parentTaskId`.
 * - A cancelled or failed deliverable with a LATER deliverable of the same
 *   title (bracket prefix stripped) is a re-creation: it folds under the newest
 *   such task. Two completed tasks that share a title stay two rows.
 * - An attempt whose parent was folded follows it to the survivor. One whose
 *   parent is not in the set goes to `bookkeeping` (its trace stays reachable
 *   from the orchestrator row; it is never promoted to a row).
 */
export function foldMissionDeliverables<T extends MissionFeedTaskInput>(tasks: readonly T[]): FoldedDeliverables<T> {
  const sorted = [...tasks].sort(byCreated);
  const deliverables: T[] = [];
  const attempts: T[] = [];
  const bookkeeping: T[] = [];
  for (const t of sorted) {
    // `taskClass` is the one attempt discriminator (task-class invariants A.5).
    if (isAttempt(t)) attempts.push(t);
    else if (isDeliverableTask(t)) deliverables.push(t);
    else bookkeeping.push(t);
  }

  // Re-creations → survivor.
  const newestByTitle = new Map<string, T>();
  for (const t of deliverables) newestByTitle.set(normTitle(t.title), t);
  const survivorOf = new Map<string, string>();
  for (const t of deliverables) {
    const newest = newestByTitle.get(normTitle(t.title))!;
    if (newest.id !== t.id && SUPERSEDABLE.has(t.status)) survivorOf.set(t.id, newest.id);
  }

  const rows: DeliverableRow<T>[] = [];
  const rowById = new Map<string, DeliverableRow<T>>();
  for (const t of deliverables) {
    if (survivorOf.has(t.id)) continue;
    const row = { task: t, attempts: [] as T[] };
    rows.push(row);
    rowById.set(t.id, row);
  }
  for (const t of deliverables) {
    const survivor = survivorOf.get(t.id);
    if (survivor) rowById.get(survivor)!.attempts.push(t);
  }
  for (const a of attempts) {
    const parentId = a.parentTaskId ? survivorOf.get(a.parentTaskId) ?? a.parentTaskId : null;
    const row = parentId ? rowById.get(parentId) : undefined;
    if (row) row.attempts.push(a);
    else bookkeeping.push(a);
  }
  for (const row of rows) row.attempts.sort(byCreated);
  bookkeeping.sort(byCreated);
  return { rows, bookkeeping };
}

/** Pulse order: phase order, then createdAt (`groupTasksByPhase`, flattened). */
export function orderDeliverables<T extends MissionFeedTaskInput>(rows: readonly DeliverableRow<T>[]): DeliverableRow<T>[] {
  const sorted = [...rows].sort((a, b) => byCreated(a.task, b.task));
  const byId = new Map(sorted.map(r => [r.task.id, r]));
  return groupTasksByPhase(sorted.map(r => r.task)).flatMap(g => g.tasks.map(t => byId.get(t.id)!));
}

// ─── State ────────────────────────────────────────────────────────────────────

/** The five colours of the pulse, plus `skipped` (cancelled, never delivered). */
export type PulseState = 'needs_you' | 'moving' | 'queued' | 'done' | 'failed' | 'skipped';

/** Design-token name per state — the component maps these to classes. No raw colours here. */
export const PULSE_STATE_TOKEN: Record<PulseState, 'accent' | 'info' | 'border' | 'success' | 'error'> = {
  needs_you: 'accent',
  moving: 'info',
  queued: 'border',
  done: 'success',
  failed: 'error',
  skipped: 'border',
};

export const PULSE_STATE_GLYPH: Record<PulseState, string> = {
  needs_you: '!',
  moving: '▯',
  queued: '░',
  done: '▮',
  failed: '✕',
  skipped: '░',
};

/** Why a row is in NEEDS YOU. */
export type NeedsYouReason = 'input' | 'question' | 'decision' | 'pr' | 'failed';

/**
 * The PR as the feed shows it. Every `workers.prLifecycleStatus` value maps to
 * exactly one of these (table-tested in mission-pulse.test.ts):
 *
 * | lifecycle            | FeedPrState      | tone    |
 * |----------------------|------------------|---------|
 * | null (unknown)       | open             | info    |
 * | pr_open, ci_running  | checks_running   | info    |
 * | ci_green             | open             | info    |
 * | ci_failed            | ci_failed        | error   |
 * | conflict             | conflict         | error   |
 * | merged / mergedAt    | merged           | success |
 * | closed               | closed           | error   |
 * | unresolvable         | unresolvable     | error   |
 */
export type FeedPrState =
  | 'open' | 'checks_running' | 'merged' | 'ci_failed' | 'conflict' | 'closed' | 'unresolvable';

/** Design-token per PR state (the row's `#N` colour follows the real PR, not a constant). */
export const PR_STATE_TOKEN: Record<FeedPrState, 'info' | 'success' | 'error'> = {
  open: 'info',
  checks_running: 'info',
  merged: 'success',
  ci_failed: 'error',
  conflict: 'error',
  closed: 'error',
  unresolvable: 'error',
};

export function deriveFeedPrState(worker: MissionFeedWorkerInput | null | undefined): { number: number; state: FeedPrState } | null {
  if (!worker?.prNumber) return null;
  if (worker.mergedAt) return { number: worker.prNumber, state: 'merged' };
  const state: FeedPrState = (() => {
    switch (worker.prLifecycleStatus) {
      case 'merged': return 'merged';
      case 'closed': return 'closed';
      case 'unresolvable': return 'unresolvable';
      case 'conflict': return 'conflict';
      case 'ci_failed': return 'ci_failed';
      case 'pr_open':
      case 'ci_running': return 'checks_running';
      default: return 'open'; // ci_green, or unknown
    }
  })();
  return { number: worker.prNumber, state };
}

const LIVE = new Set<string>(LIVE_WORKER_STATUSES);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const CLAIMED_TASK_STATUSES = new Set(['assigned', 'in_progress']);

function isMoving(t: MissionFeedTaskInput): boolean {
  const ws = t.worker?.status;
  if (ws && ws !== 'waiting_input' && LIVE.has(ws)) return true;
  return CLAIMED_TASK_STATUSES.has(t.status);
}

export interface FeedTaskState {
  state: PulseState;
  needsYou: NeedsYouReason | null;
  /** When the ask was made (ms), for "oldest ask first". Null when not needs-you. */
  askedAt: number | null;
}

/**
 * One state per row. Precedence: a question to the human (input, question,
 * decision) → live work (the row's own worker, or an open attempt that has
 * been claimed) → the task's own outcome (PR awaiting merge, failure with no
 * automatic retry pending) → queued/done/skipped.
 */
export function deriveFeedTaskState(row: DeliverableRow, ctx: MissionFeedContext = {}): FeedTaskState {
  const { task } = row;
  const openAttempt = [...row.attempts].reverse().find(a => !TERMINAL.has(a.status) && a.taskClass !== 'work');
  const fallbackAsk = ms(task.updatedAt ?? task.createdAt);
  const needs = (reason: NeedsYouReason, at: number): FeedTaskState => ({
    state: 'needs_you', needsYou: reason, askedAt: Number.isFinite(at) ? at : fallbackAsk,
  });

  if (task.worker?.status === 'waiting_input' || openAttempt?.worker?.status === 'waiting_input') {
    return needs('input', ms(task.worker?.updatedAt ?? openAttempt?.worker?.updatedAt ?? null));
  }
  const q = ctx.openQuestions?.get(task.id);
  if (q != null) return needs('question', ms(q));
  const d = ctx.openDecisions?.get(task.id);
  if (d != null) return needs('decision', ms(d));

  if (isMoving(task) || (openAttempt && isMoving(openAttempt))) return { state: 'moving', needsYou: null, askedAt: null };

  if (task.status === 'completed') {
    const pr = deriveFeedPrState(task.worker);
    switch (pr?.state) {
      // CI has not reported or is running. Auto-merge evaluates on the green
      // transition, so the platform — not you — owns the next step.
      case 'checks_running':
        return { state: 'moving', needsYou: null, askedAt: null };
      // Terminal: buildd cannot resolve this PR against GitHub. It belongs to
      // the health surface, not the action queue (nobody can act on it here).
      case 'unresolvable':
        return { state: 'failed', needsYou: null, askedAt: null };
      // Green (or unknown) and still open: auto-merge already ran on green and
      // declined, or is off — the merge is yours. Red / conflicted with no fix
      // attempt queued is yours too. An open fix attempt means the platform
      // owes the next push, not you.
      case 'open':
        return openAttempt ? { state: 'queued', needsYou: null, askedAt: null } : needs('pr', fallbackAsk);
      case 'ci_failed':
      case 'conflict':
        return openAttempt ? { state: 'failed', needsYou: null, askedAt: null } : needs('pr', fallbackAsk);
      default: // merged, closed, or no PR
        return { state: 'done', needsYou: null, askedAt: null };
    }
  }
  if (task.status === 'failed') {
    return openAttempt ? { state: 'failed', needsYou: null, askedAt: null } : needs('failed', fallbackAsk);
  }
  if (task.status === 'cancelled') return { state: 'skipped', needsYou: null, askedAt: null };
  return { state: 'queued', needsYou: null, askedAt: null };
}

// ─── Segments ─────────────────────────────────────────────────────────────────

/** Above this many rows the pulse draws one segment per phase. */
export const PULSE_FOLD_THRESHOLD = 40;

interface PulseSegmentBase {
  /** Row this segment focuses. For a phase segment: the phase's first row (scrub → phase header). */
  taskId: string;
  state: PulseState;
  phaseIndex: number | null;
  phaseLabel: string | null;
  /** Draw the 2px phase-boundary gap before this segment. */
  gapBefore: boolean;
  /** 0..1 filled fraction — 1 for a task segment, the done fraction for a phase segment. */
  fill: number;
}

export type PulseSegment =
  | (PulseSegmentBase & { kind: 'task' })
  | (PulseSegmentBase & { kind: 'phase'; taskIds: string[] });

const phaseKey = (t: MissionFeedTaskInput) =>
  t.missionPhaseIndex != null && t.missionPhaseLabel != null ? `p${t.missionPhaseIndex}` : 'none';

function aggregateState(states: PulseState[]): PulseState {
  if (states.includes('needs_you')) return 'needs_you';
  if (states.includes('moving')) return 'moving';
  if (states.includes('failed')) return 'failed';
  if (states.every(s => s === 'done' || s === 'skipped')) return states.every(s => s === 'skipped') ? 'skipped' : 'done';
  return 'queued';
}

/**
 * Build the pulse from a mission's tasks (any mix — non-deliverables are
 * dropped by `foldMissionDeliverables`). The same output feeds every size
 * variant (card, header, context), so a task's position is learnable.
 */
export function buildPulseSegments(tasks: readonly MissionFeedTaskInput[], ctx: MissionFeedContext = {}): PulseSegment[] {
  const ordered = orderDeliverables(foldMissionDeliverables(tasks).rows);
  const withState = ordered.map(row => ({ row, state: deriveFeedTaskState(row, ctx).state }));
  const hasPhases = groupTasksByPhase(ordered.map(r => r.task)).some(g => g.index !== null);

  if (withState.length <= PULSE_FOLD_THRESHOLD) {
    let prev: string | null = null;
    return withState.map(({ row, state }) => {
      const key = phaseKey(row.task);
      const gapBefore = hasPhases && prev !== null && key !== prev;
      prev = key;
      return {
        kind: 'task' as const, taskId: row.task.id, state,
        phaseIndex: row.task.missionPhaseIndex ?? null, phaseLabel: row.task.missionPhaseLabel ?? null,
        gapBefore, fill: 1,
      };
    });
  }

  const phases: Array<{ key: string; items: typeof withState }> = [];
  for (const item of withState) {
    const key = phaseKey(item.row.task);
    const last = phases[phases.length - 1];
    if (last && last.key === key) last.items.push(item);
    else phases.push({ key, items: [item] });
  }
  return phases.map((p, i) => {
    const first = p.items[0].row.task;
    const states = p.items.map(x => x.state);
    const done = states.filter(s => s === 'done' || s === 'skipped').length;
    return {
      kind: 'phase' as const, taskId: first.id, taskIds: p.items.map(x => x.row.task.id),
      state: aggregateState(states),
      phaseIndex: first.missionPhaseIndex ?? null, phaseLabel: first.missionPhaseLabel ?? null,
      gapBefore: i > 0, fill: done / p.items.length,
    };
  });
}
