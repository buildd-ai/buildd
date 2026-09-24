/**
 * The mission feed's grouping model (docs/design/mission-feed-mobile-continuity.md,
 * "Grouping rules"). Pure: tasks in, ordered groups out.
 *
 * L-1: every deliverable renders as a row EXACTLY once. A row promoted into a
 * pinned group (NEEDS YOU, MOVING NOW) leaves a slot marker at its place in its
 * phase — a marker, not a second row — so phase counts and `n / N` stay stable.
 * Collapse/cap fields describe the default render; the rows themselves are all
 * present in the model, so the UI can unfold without re-deriving anything.
 */
import {
  deriveFeedPrState,
  deriveFeedTaskState,
  foldMissionDeliverables,
  orderDeliverables,
  type DeliverableRow,
  type FeedPrState,
  type MissionFeedContext,
  type MissionFeedTaskInput,
  type NeedsYouReason,
  type PulseState,
} from './mission-pulse';

export const NEEDS_YOU_VISIBLE_CAP = 3;
export const FUTURE_PHASE_VISIBLE_CAP = 3;

export interface FeedRowPosition {
  /** 1-based index in pulse order. */
  n: number;
  total: number;
  phaseLabel: string | null;
  prevTaskId: string | null;
  nextTaskId: string | null;
}

export interface FeedRow<T extends MissionFeedTaskInput = MissionFeedTaskInput> {
  taskId: string;
  task: T;
  state: PulseState;
  needsYou: NeedsYouReason | null;
  askedAt: number | null;
  /** Folded retries / reviewer passes / superseded re-creations (D1), oldest first. */
  attempts: T[];
  pr: { number: number; state: FeedPrState } | null;
  /** First unfinished dependency in this mission, for "after #x". */
  blockedByTaskId: string | null;
  position: FeedRowPosition;
}

export type FeedPhaseItem<T extends MissionFeedTaskInput = MissionFeedTaskInput> =
  | { type: 'row'; row: FeedRow<T> }
  | { type: 'slot'; taskId: string; title: string; pinnedIn: 'needs_you' | 'moving' };

export type FeedGroup<T extends MissionFeedTaskInput = MissionFeedTaskInput> =
  | { kind: 'needs_you'; rows: FeedRow<T>[]; visibleLimit: number; hiddenCount: number }
  | { kind: 'moving'; rows: FeedRow<T>[] }
  | {
      kind: 'phase';
      /** Stored `missionPhaseIndex`, or null for the unphased group. */
      index: number | null;
      label: string | null;
      /** 1-based display number ("2 · BUILD"). */
      ordinal: number;
      status: 'finished' | 'current' | 'future';
      /** Finished phases fold to their header row. */
      collapsed: boolean;
      /** Rows shown before "+N queued"; null = all. */
      visibleLimit: number | null;
      hiddenCount: number;
      done: number;
      total: number;
      items: FeedPhaseItem<T>[];
    };

export interface MissionFeedModel<T extends MissionFeedTaskInput = MissionFeedTaskInput> {
  groups: FeedGroup<T>[];
  /** Row ids in pulse order — the numbering and ‹ › stepping order. */
  order: string[];
  rowsById: Map<string, FeedRow<T>>;
  /** Orchestrator/bookkeeping rows and orphan attempts: one footer row, never list rows. */
  bookkeeping: T[];
  /** The next NEEDS YOU row after `fromTaskId` (wrapping), excluding it; the first when absent. */
  nextNeedingYou(fromTaskId: string | null): string | null;
}

const DONE_STATES = new Set<PulseState>(['done', 'skipped']);
const ms = (d: Date | string | null | undefined) => (d == null ? NaN : new Date(d).getTime());
const hasPhase = (t: MissionFeedTaskInput) => t.missionPhaseIndex != null && t.missionPhaseLabel != null;
const phaseKey = (t: MissionFeedTaskInput) => (hasPhase(t) ? `p${t.missionPhaseIndex}` : 'none');

/** Rank inside a phase: failed, queued (ready before blocked), done, skipped. */
function rank(row: FeedRow): number {
  if (row.state === 'failed') return 0;
  if (row.state === 'queued') return row.blockedByTaskId ? 2 : 1;
  if (row.state === 'done') return 3;
  if (row.state === 'skipped') return 4;
  return 1;
}

export function buildMissionFeedGroups<T extends MissionFeedTaskInput>(
  tasks: readonly T[],
  ctx: MissionFeedContext = {},
): MissionFeedModel<T> {
  const folded = foldMissionDeliverables(tasks);
  const ordered: DeliverableRow<T>[] = orderDeliverables(folded.rows);
  const order = ordered.map(r => r.task.id);

  // Folded ids → survivor, so a dependency on a superseded task resolves to its row.
  const rowIdFor = new Map<string, string>();
  for (const r of ordered) {
    rowIdFor.set(r.task.id, r.task.id);
    for (const a of r.attempts) rowIdFor.set(a.id, r.task.id);
  }

  const rows: FeedRow<T>[] = ordered.map((r, i) => {
    const s = deriveFeedTaskState(r, ctx);
    return {
      taskId: r.task.id, task: r.task, state: s.state, needsYou: s.needsYou, askedAt: s.askedAt,
      attempts: r.attempts, pr: deriveFeedPrState(r.task.worker), blockedByTaskId: null,
      position: {
        n: i + 1, total: ordered.length, phaseLabel: r.task.missionPhaseLabel ?? null,
        prevTaskId: order[i - 1] ?? null, nextTaskId: order[i + 1] ?? null,
      },
    };
  });
  const rowsById = new Map(rows.map(r => [r.taskId, r]));
  for (const row of rows) {
    if (row.state !== 'queued') continue;
    for (const dep of row.task.dependsOn ?? []) {
      const depRow = rowsById.get(rowIdFor.get(dep) ?? dep);
      if (depRow && depRow.taskId !== row.taskId && !DONE_STATES.has(depRow.state)) {
        row.blockedByTaskId = depRow.taskId;
        break;
      }
    }
  }

  const needsYou = rows.filter(r => r.state === 'needs_you')
    .sort((a, b) => (a.askedAt ?? Infinity) - (b.askedAt ?? Infinity) || a.position.n - b.position.n);
  const moving = rows.filter(r => r.state === 'moving').sort((a, b) => {
    const as = ms(a.task.worker?.startedAt), bs = ms(b.task.worker?.startedAt);
    return (Number.isFinite(as) ? as : Infinity) - (Number.isFinite(bs) ? bs : Infinity) || a.position.n - b.position.n;
  });

  const groups: FeedGroup<T>[] = [];
  if (needsYou.length > 0) {
    groups.push({
      kind: 'needs_you', rows: needsYou, visibleLimit: NEEDS_YOU_VISIBLE_CAP,
      hiddenCount: Math.max(0, needsYou.length - NEEDS_YOU_VISIBLE_CAP),
    });
  }
  if (moving.length > 0) groups.push({ kind: 'moving', rows: moving });

  // Phases, in pulse order (contiguous by construction).
  const phases: Array<{ rows: FeedRow<T>[] }> = [];
  let lastKey: string | null = null;
  for (const row of rows) {
    const key = phaseKey(row.task);
    if (key !== lastKey) phases.push({ rows: [] });
    phases[phases.length - 1].rows.push(row);
    lastKey = key;
  }
  let currentAssigned = false;
  phases.forEach((p, i) => {
    const done = p.rows.filter(r => DONE_STATES.has(r.state)).length;
    const finished = done === p.rows.length;
    const status = finished ? 'finished' : currentAssigned ? 'future' : 'current';
    if (status === 'current') currentAssigned = true;

    const slots: FeedPhaseItem<T>[] = p.rows
      .filter(r => r.state === 'needs_you' || r.state === 'moving')
      .map(r => ({ type: 'slot', taskId: r.taskId, title: r.task.title, pinnedIn: r.state === 'needs_you' ? 'needs_you' : 'moving' }));
    const own = p.rows
      .filter(r => r.state !== 'needs_you' && r.state !== 'moving')
      .sort((a, b) => rank(a) - rank(b) || a.position.n - b.position.n)
      .map(row => ({ type: 'row' as const, row }));
    const visibleLimit = status === 'future' ? FUTURE_PHASE_VISIBLE_CAP : null;
    const first = p.rows[0].task;
    groups.push({
      kind: 'phase',
      // A phase is only a phase with both halves; a half-set pair is unphased (same rule as phaseKey).
      index: hasPhase(first) ? first.missionPhaseIndex! : null,
      label: hasPhase(first) ? first.missionPhaseLabel! : null,
      ordinal: i + 1,
      status,
      collapsed: status === 'finished',
      visibleLimit,
      hiddenCount: visibleLimit === null ? 0 : Math.max(0, own.length - visibleLimit),
      done,
      total: p.rows.length,
      items: [...slots, ...own],
    });
  });

  const needsOrder = needsYou.map(r => r.taskId);
  return {
    groups,
    order,
    rowsById,
    bookkeeping: folded.bookkeeping,
    nextNeedingYou(fromTaskId) {
      if (needsOrder.length === 0) return null;
      const at = fromTaskId ? needsOrder.indexOf(fromTaskId) : -1;
      if (at === -1) return needsOrder[0];
      return needsOrder.length > 1 ? needsOrder[(at + 1) % needsOrder.length] : null;
    },
  };
}
