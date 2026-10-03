/**
 * The mission page's Landed strip, as data: which cell is selected by
 * default, where the drawer's caret sits under it, and how the keyboard and
 * the stepper move. Pure, so the strip's rules are tested without a DOM.
 *
 * Strip order is the board's: phases in order, tasks in phase order.
 */
import { BOARD_LANDED, type BoardStatus, type MissionBoardModel } from './mission-board';

export function stripOrder(model: Pick<MissionBoardModel, 'phases'>): string[] {
  return model.phases.flatMap(p => p.taskIds);
}

const isOpen = (status: BoardStatus | undefined) => !!status && !BOARD_LANDED.has(status);

/** Indices of the unfinished tasks, in strip order. */
export function openIndices(order: readonly string[], statusOf: (id: string) => BoardStatus | undefined): number[] {
  return order.flatMap((id, i) => (isOpen(statusOf(id)) ? [i] : []));
}

/**
 * The cell selected on arrival: the task the situation block is about, when
 * the strip has it; else the first unfinished task; else (all landed) the last.
 */
export function defaultStripSelection(
  order: readonly string[],
  statusOf: (id: string) => BoardStatus | undefined,
  focusTaskId?: string | null,
): string | null {
  if (order.length === 0) return null;
  if (focusTaskId && order.includes(focusTaskId)) return focusTaskId;
  const open = openIndices(order, statusOf);
  return order[open.length ? open[0] : order.length - 1];
}

/** The next unfinished task after `sel`, wrapping; `sel` itself when it is the only one. */
export function nextOpenIndex(open: readonly number[], sel: number): number | null {
  if (open.length === 0) return null;
  return open.find(i => i > sel) ?? open[0];
}

/** Step `delta` cells, wrapping at both ends. */
export function stepIndex(i: number, delta: number, n: number): number {
  return n === 0 ? 0 : (((i + delta) % n) + n) % n;
}

/** The toolbar's keys: ArrowLeft/Right step, Home/End jump. Anything else is not ours. */
export function stripKeyTarget(key: string, i: number, n: number): number | null {
  switch (key) {
    case 'ArrowRight': return stepIndex(i, 1, n);
    case 'ArrowLeft': return stepIndex(i, -1, n);
    case 'Home': return 0;
    case 'End': return n - 1;
    default: return null;
  }
}

/**
 * Horizontal centre of cell `i` of `n` equal flex cells separated by
 * `var(--strip-gap)`: exact under flex gap, so the caret sits on the cell.
 */
export function stripCaretLeft(i: number, n: number): string {
  if (n <= 0) return '0px';
  return `calc((100% - var(--strip-gap) * ${n - 1}) * ${(i + 0.5) / n} + var(--strip-gap) * ${i})`;
}

/** `07`: the tick under a cell and the drawer's `07 / 10`. */
export const stripTick = (i: number) => String(i + 1).padStart(2, '0');
