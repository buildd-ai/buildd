import { deliverableRole } from './roles';
import type { BoardTaskInput, Cell } from './types';

/** One bar cell per ordinary task. Mission-level checks are not cells. */
export function buildBoardCells(tasks: BoardTaskInput[]): Cell[] {
  return tasks
    .filter((t) => deliverableRole(t) === null)
    .map((t) => ({ id: t.id, label: t.title, status: t.status }));
}
