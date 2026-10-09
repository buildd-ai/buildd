/**
 * The mission Overview's rules as data: which task is selected on arrival,
 * the strip's cells and marks, and the focus card's reason line. Pure, so it
 * is tested over real board models without a DOM.
 */
import type { TaskStripCell } from '@/components/ui/TaskStrip';
import { reasonLine, type StripMark } from '@/components/ui/task-strip';
import { BOARD_LANDED, type MissionBoardModel } from './mission-board';
import { isActiveState, stripMarks, stripOrder, stripState, stripTick } from './mission-task-strip';

type Model = Pick<MissionBoardModel, 'phases' | 'tasks'>;

/**
 * The task on arrival: the one setting the finish. With estimates, the first
 * unfinished task on the critical path (`criticalPath`, strip order); until a
 * mission has them, the first task in flight. Never the first task for its own
 * sake: a mission with nothing in flight falls to the first held task, and a
 * finished one to the last.
 */
export function finishSettingTaskId(model: Model, order: readonly string[] = stripOrder(model), criticalPath?: ReadonlySet<string> | null): string | null {
  if (order.length === 0) return null;
  const unfinished = order.filter(id => !BOARD_LANDED.has(model.tasks[id].status));
  if (criticalPath && criticalPath.size > 0) {
    const onPath = unfinished.find(id => criticalPath.has(id));
    if (onPath) return onPath;
  }
  const inFlight = unfinished.find(id => isActiveState(stripState(model, id)));
  return inFlight ?? unfinished[0] ?? order[order.length - 1];
}

/** One strip cell per task, in strip order, ticked by position. */
export function overviewCells(model: Model, order: readonly string[] = stripOrder(model)): TaskStripCell[] {
  return order.map((id, i) => ({ id, state: stripState(model, id), tick: stripTick(i), title: model.tasks[id].title }));
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

/** `2 of 7 merged · 1 of 4 criteria`; `{ criteria: false }` leaves the criteria to the Verified pill. */
export function overviewCounts(model: Pick<MissionBoardModel, 'landed' | 'criteria' | 'criteriaPassed'>, opts: { criteria?: boolean } = {}): string {
  const parts = [`${model.landed.done} of ${model.landed.total} merged`];
  if (opts.criteria !== false && model.criteria.length > 0) parts.push(`${model.criteriaPassed} of ${model.criteria.length} criteria`);
  return parts.join(' · ');
}
