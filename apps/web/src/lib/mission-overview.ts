// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * The mission Overview's rules as data: which task is selected on arrival,
 * the strip's cells and marks, and the focus card's reason line. Pure, so it
 * is tested over real board models without a DOM.
 */
import type { TaskStripCell, TaskStripWait } from '@/components/ui/TaskStrip';
import type { StateKey } from '@/components/ui/states';
import { reasonLine, type StripMark } from '@/components/ui/task-strip';
import { WAITING_KIND_SPEC, type WaitingKind } from '@buildd/core/waiting-reason';
import { BOARD_LANDED, type MissionBoardModel } from './mission-board';
import { isActiveState, isHeldState, stripMarks, stripOrder, stripState, stripTick } from './mission-task-strip';

type Model = Pick<MissionBoardModel, 'phases' | 'tasks'>;

/** The Overview rail's two counts, said in words. */
export function railLines(live: number, needs: number): { agents: string; needs: string } {
  return {
    agents: live === 0 ? 'No agents working' : `${live} ${live === 1 ? 'agent' : 'agents'} working`,
    needs: needs === 0 ? 'Nothing waiting on you' : `${needs} waiting on you`,
  };
}

/**
 * The task on arrival: the first task in flight. Never the first task for its
 * own sake: a mission with nothing in flight falls to the first held task,
 * and a finished one to the last.
 */
export function finishSettingTaskId(model: Model, order: readonly string[] = stripOrder(model)): string | null {
  if (order.length === 0) return null;
  const unfinished = order.filter(id => !BOARD_LANDED.has(model.tasks[id].status));
  const inFlight = unfinished.find(id => isActiveState(stripState(model, id)));
  return inFlight ?? unfinished[0] ?? order[order.length - 1];
}

/**
 * The selected task (spec f7f67f1a R-6, R-9): the one the viewer chose while it
 * is still on the strip, so a task keeps its selection when it changes group;
 * else the task a hold names (the situation block's task); else the first
 * task in flight.
 */
export function overviewDefaultSelection(model: Model, order: readonly string[], chosen: string | null, held: string | null): string | null {
  if (chosen && order.includes(chosen)) return chosen;
  if (held && order.includes(held)) return held;
  return finishSettingTaskId(model, order);
}

// ── Groups (spec f7f67f1a R-1) ───────────────────────────────────────────────

/** Done, In progress and Waiting hold build work; checks holds audit, fix and refresh rows. */
export type OverviewGroupKey = 'done' | 'active' | 'waiting' | 'checks';

export interface OverviewLayout {
  /** Every task, group by group: the order the strip draws and the keys step through. */
  order: string[];
  /** Non-empty groups only, in display order. */
  groups: { key: OverviewGroupKey; ids: string[] }[];
}

const GROUP_ORDER: readonly OverviewGroupKey[] = ['done', 'active', 'waiting', 'checks'];

/**
 * A kernel-owned delivery the kernel settled without shipping it: its PR closed
 * unmerged and nothing superseded it (the kernel's `deliveryShipped` is false;
 * a superseded one reads `landed`, not `closed`). The board's tone map still
 * files it as finished (S17), so the Overview decides this itself (R-2).
 */
export function isClosedUnshipped(model: Model, id: string): boolean {
  return model.tasks[id]?.delivery?.tone === 'closed';
}

/** The cell's display state: the strip's, except a closed, unshipped delivery is `not_landed`, never green. */
export function overviewCellState(model: Model, id: string): StateKey {
  return isClosedUnshipped(model, id) ? 'not_landed' : stripState(model, id);
}

function groupOf(model: Model, id: string): OverviewGroupKey {
  if (model.tasks[id].deliverableRole !== 'build') return 'checks';
  if (isClosedUnshipped(model, id)) return 'waiting';
  const state = stripState(model, id);
  if (state === 'landed') return 'done';
  return state === 'ready' || isHeldState(state) ? 'waiting' : 'active';
}

/**
 * The Overview's groups. Strip order (dependency order) holds inside each
 * group; only a status change moves a task between groups. Other strips keep
 * plain strip order.
 */
export function overviewLayout(model: Model, order: readonly string[] = stripOrder(model)): OverviewLayout {
  const byGroup = new Map<OverviewGroupKey, string[]>(GROUP_ORDER.map(k => [k, []]));
  for (const id of order) byGroup.get(groupOf(model, id))!.push(id);
  const groups = GROUP_ORDER.filter(k => byGroup.get(k)!.length > 0).map(key => ({ key, ids: byGroup.get(key)! }));
  return { order: groups.flatMap(g => g.ids), groups };
}

// ── Why a task waits (spec f7f67f1a R-5) ─────────────────────────────────────

/** On other work, for a free runner, on a hold, for a reason nobody recorded, or closed without merging. */
export type OverviewWaitCause = TaskStripWait;

const ON_TASKS: ReadonlySet<WaitingKind> = new Set<WaitingKind>([
  'dep_declared', 'dep_inferred', 'ordered_behind', 'pr_overlap_live', 'pr_overlap_ended',
  'lease_overlap', 'lease_stale', 'soft_overlap', 'serialized_surface', 'scope_undeclared_mutex',
]);
const FOR_SLOT: ReadonlySet<WaitingKind> = new Set<WaitingKind>([
  'mission_concurrent', 'mission_paced', 'workspace_cap', 'account_slots', 'oauth_parallelism',
  'codex_single_flight', 'eligible_no_runner', 'dispatch_undelivered', 'runner_preference',
]);

/**
 * Why a waiting build task is not running, from the claim gate's own waiting
 * kind (P-1). Without one, the strip's state decides: held behind a task is
 * `tasks`, nothing holding it is `slot`. An `unknown` kind stays unknown and
 * never reads as an unmet dependency. Null for a task that is not waiting.
 */
export function overviewWaitCause(model: Model, id: string): OverviewWaitCause | null {
  const t = model.tasks[id];
  if (!t || groupOf(model, id) !== 'waiting') return null;
  if (isClosedUnshipped(model, id)) return 'closed';
  const kind = t.waitingKind;
  if (kind === 'unknown') return 'unknown';
  if (kind) return ON_TASKS.has(kind) ? 'tasks' : FOR_SLOT.has(kind) ? 'slot' : 'hold';
  return isHeldState(stripState(model, id)) ? 'tasks' : 'slot';
}

const WAIT_WORD: Record<OverviewWaitCause, string> = { tasks: 'Waiting on tasks', slot: 'Next in line', hold: 'Held', unknown: 'Waiting', closed: 'Closed without merging' };
const WAIT_LEGEND: Record<OverviewWaitCause, string> = { tasks: 'waiting on tasks', slot: 'next in line', hold: 'held', unknown: 'not started', closed: 'closed without merging' };

export interface OverviewLegendEntry {
  key: 'done' | 'active' | OverviewWaitCause | 'checks';
  count: number;
  text: string;
}

/** The counts beside the strip, in words: `5 done`, `2 in progress`, waiting split by cause. */
export function overviewLegend(model: Model, layout: OverviewLayout): OverviewLegendEntry[] {
  const ids = (k: OverviewGroupKey) => layout.groups.find(g => g.key === k)?.ids ?? [];
  const waiting = ids('waiting');
  const byCause = (c: OverviewWaitCause) => waiting.filter(id => overviewWaitCause(model, id) === c).length;
  const checks = ids('checks').length;
  const entries: OverviewLegendEntry[] = [
    { key: 'done', count: ids('done').length, text: `${ids('done').length} done` },
    { key: 'active', count: ids('active').length, text: `${ids('active').length} in progress` },
    ...(['tasks', 'slot', 'hold', 'unknown', 'closed'] as const).map(c => ({ key: c, count: byCause(c), text: `${byCause(c)} ${WAIT_LEGEND[c]}` })),
    { key: 'checks', count: checks, text: `${checks} ${checks === 1 ? 'check' : 'checks'}` },
  ];
  return entries.filter(e => e.count > 0);
}

/**
 * The focus card's line for a waiting or closed task (R-5, R-10): what holds
 * it and what lets it start, from the claim gate's waiting kind. Null when the
 * strip's own reason says it better (waiting on tasks, or no recorded kind).
 */
export function overviewWaitLine(model: Model, id: string): string | null {
  const cause = overviewWaitCause(model, id);
  if (cause === 'closed') return 'Closed without merging. The mission cannot finish until it is reopened or replaced.';
  if (cause === 'unknown') return 'Not started. No reason is recorded yet.';
  const kind = model.tasks[id]?.waitingKind;
  if (!kind || cause === 'tasks' || cause == null) return null;
  const spec = WAITING_KIND_SPEC[kind];
  return `${spec.gateName}. Starts when ${spec.releasesWhen.text}.`;
}

/** One strip cell per task, in the order given, ticked by position; a waiting cell carries its cause. */
export function overviewCells(model: Model, order: readonly string[] = stripOrder(model)): TaskStripCell[] {
  return order.map((id, i) => {
    const wait = overviewWaitCause(model, id);
    return { id, state: overviewCellState(model, id), tick: stripTick(i), title: model.tasks[id].title, ...(wait ? { wait, word: WAIT_WORD[wait] } : {}) };
  });
}

/** What the selection marks on the tick row, and the focus card's reason line. */
export function overviewSelection(model: Model, order: readonly string[], selectedId: string) {
  const t = model.tasks[selectedId];
  if (!t) return { marks: new Map<string, StripMark>(), reason: null };
  const sel = stripMarks(model, selectedId);
  const tick = (id: string) => stripTick(order.indexOf(id));
  const name = (id: string) => `${tick(id)} ${model.tasks[id].scope ?? model.tasks[id].label}`;
  const byTick = (a: string, b: string) => tick(a).localeCompare(tick(b));
  if (sel.direction === 'downstream') {
    const direct = sel.reached.filter(id => sel.marks.get(id) === 'direct').sort(byTick).map(tick);
    return { marks: sel.marks, reason: reasonLine('downstream', direct, sel.reached.length) };
  }
  if (sel.direction === 'upstream') {
    const names = [
      ...t.offStrip.map(b => `${b.title}${b.otherMission ? ' · other mission' : ''}`),
      ...t.frontier.filter(id => model.tasks[id]).sort(byTick).map(name),
    ];
    return { marks: sel.marks, reason: reasonLine('upstream', names, t.offStrip.length + sel.reached.length) };
  }
  return { marks: sel.marks, reason: null };
}

/** `2 of 7 landed · 1 of 4 criteria`; `{ criteria: false }` leaves the criteria to the Verified pill. */
export function overviewCounts(model: Pick<MissionBoardModel, 'landed' | 'criteria' | 'criteriaPassed'>, opts: { criteria?: boolean } = {}): string {
  // "landed", not "merged": this counts every finished task, PR or not (the
  // Board's LANDED cell), while the PRs merged criterion counts PR-bearing
  // tasks only. Both called "merged" read as two contradictory merged counts.
  const parts = [model.landed.total === 0 ? 'No tasks' : `${model.landed.done} of ${model.landed.total} landed`];
  if (opts.criteria !== false && model.criteria.length > 0) parts.push(`${model.criteriaPassed} of ${model.criteria.length} criteria`);
  return parts.join(' · ');
}
