import type { Cell } from './types';

export function overviewProgress(cells: Cell[]) {
  const done = cells.filter((c) => c.status === 'completed').length;
  return { done, total: cells.length };
}
