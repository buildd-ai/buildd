/**
 * The dependency-first task order, from feed rows.
 *
 * Every task strip (Landed strip, list/Home phase bar, masthead pulse) draws
 * the order `stripOrder` gives over `buildBoardCells`. This is the entry point
 * for callers that hold feed rows (`MissionFeedTaskInput`) rather than board
 * rows, so they do not each re-derive it. Pure; cancelled tasks get no cell.
 */
import { buildBoardCells, toBoardTaskInput, type BoardExternalDepInput } from './mission-board';
import type { BlockingTask } from './mission-card-view';
import type { MissionFeedTaskInput } from './mission-pulse';
import { stripOrder } from './mission-task-strip';

export function feedStripOrder(
  tasks: readonly MissionFeedTaskInput[],
  externalDeps: readonly BoardExternalDepInput[] = [],
): string[] {
  const rows = tasks.map(t => toBoardTaskInput({ ...t, workers: t.worker ? [{ ...t.worker, id: t.id }] : [] }));
  return stripOrder(buildBoardCells({ tasks: rows, externalDeps: [...externalDeps] }));
}

type TaskRow = Parameters<typeof toBoardTaskInput>[0] & { dependsOn?: readonly string[] | null };

/**
 * The same order from task rows as the mission queries load them (with their
 * `workers`). `taskIndex` is the page's cross-mission index: a dependency on
 * another mission's task is judged from it, the way the mission page judges
 * its `externalDeps`; a dependency outside it is unknown.
 */
export function taskRowsStripOrder(
  tasks: readonly TaskRow[],
  taskIndex?: ReadonlyMap<string, BlockingTask & { title?: string | null }>,
): string[] {
  const rows = tasks.map(t => toBoardTaskInput(t));
  return stripOrder(buildBoardCells({ tasks: rows, externalDeps: taskIndex ? externalDepsOf(tasks, taskIndex) : [] }));
}

/** The mission's dependencies on tasks outside it, as the board reads them. */
function externalDepsOf(
  tasks: readonly TaskRow[],
  index: ReadonlyMap<string, BlockingTask & { title?: string | null }>,
): BoardExternalDepInput[] {
  const own = new Set(tasks.map(t => t.id));
  const ids = new Set(tasks.flatMap(t => t.dependsOn ?? []).filter(id => !own.has(id)));
  return [...ids].flatMap(id => {
    const row = index.get(id);
    return row ? [{ id, title: row.title ?? null, status: row.status, workers: (row.workers ?? []) as BoardExternalDepInput['workers'] }] : [];
  });
}
