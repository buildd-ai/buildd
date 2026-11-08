import type { BoardTaskInput, Cell } from './types';

/** One bar cell per ordinary task. */
export function buildBoardCells(tasks: BoardTaskInput[]): Cell[] {
  return tasks
    .filter((t) => !/^\[(final verification|check)\]/i.test(t.title))
    .map((t) => ({ id: t.id, label: t.title, status: t.status }));
}
