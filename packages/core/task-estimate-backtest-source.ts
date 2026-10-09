/**
 * The query half of the size backtest: completed work tasks with their first
 * completed session, and the neighbour lookup that feeds the baseline.
 *
 * Split from `./task-estimate-backtest.ts` for the reason the task-area
 * readout is: the arithmetic is tested against literal rows with no mock.
 *
 * Neighbours come from the live vector store, which also holds tasks created
 * after the one being replayed. They are over-fetched and then restricted to
 * what the cutoff makes visible, so the ranking among visible tasks is the
 * ranking the system had at the time; a store that dropped a hit would
 * otherwise starve early tasks of neighbours that really existed.
 */
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from './db/client';
import { tasks, workers } from './db/schema';
import { TASK_AREA_FALLBACK } from './task-area-prediction';
import { findNeighbourTasks, type TaskAreaQuerier } from './task-area-prediction-source';
import type { NeighbourProvider, TaskOutcome } from './task-estimate-backtest';

/** Upper bound on tasks pulled into memory for one run. */
export const BACKTEST_TASK_LIMIT = 5000;
/** Neighbours requested per task before the cutoff trims them. */
export const BACKTEST_NEIGHBOUR_FETCH = 60;

/** Cohort: completed work tasks. Attempts and bookkeeping are not deliverables. */
export function backtestTaskScope() {
  return and(eq(tasks.taskClass, 'work'), eq(tasks.status, 'completed'));
}

/** Sessions that can size a task: completed, with a start. */
export function backtestSessionScope(taskIds: string[]) {
  return and(
    inArray(workers.taskId, taskIds),
    eq(workers.status, 'completed'),
    isNotNull(workers.startedAt),
    isNotNull(workers.completedAt),
  );
}

export async function fetchTaskOutcomes(opts: { workspaceId?: string; limit?: number } = {}): Promise<TaskOutcome[]> {
  const taskRows = await db
    .select({
      id: tasks.id, workspaceId: tasks.workspaceId, createdAt: tasks.createdAt,
      title: tasks.title, description: tasks.description, kind: tasks.kind, complexity: tasks.complexity,
    })
    .from(tasks)
    .where(opts.workspaceId ? and(backtestTaskScope(), eq(tasks.workspaceId, opts.workspaceId)) : backtestTaskScope())
    .orderBy(asc(tasks.createdAt))
    .limit(opts.limit ?? BACKTEST_TASK_LIMIT);
  if (taskRows.length === 0) return [];

  const out: TaskOutcome[] = [];
  const first = new Map<string, typeof workers.$inferSelect>();
  for (let i = 0; i < taskRows.length; i += 500) {
    const ids = taskRows.slice(i, i + 500).map(t => t.id);
    const sessions = await db.select().from(workers).where(backtestSessionScope(ids));
    for (const w of sessions) {
      const prior = first.get(w.taskId!);
      if (!prior || w.completedAt!.getTime() < prior.completedAt!.getTime()) first.set(w.taskId!, w);
    }
  }
  for (const t of taskRows) {
    const w = first.get(t.id);
    if (!w || !t.workspaceId) continue;
    const minutes = (w.completedAt!.getTime() - w.startedAt!.getTime()) / 60_000;
    const tokens = (w.inputTokens ?? 0) + (w.outputTokens ?? 0);
    out.push({
      taskId: t.id,
      workspaceId: t.workspaceId,
      createdAt: t.createdAt,
      kind: t.kind,
      complexity: t.complexity,
      seedText: [t.title ?? '', t.description ?? ''].filter(Boolean).join('\n'),
      completedAt: w.completedAt!,
      minutes: minutes > 0 ? minutes : null,
      tokens: tokens > 0 ? tokens : null,
      filesChanged: typeof w.filesChanged === 'number' ? w.filesChanged : null,
    });
  }
  return out;
}

export function vectorNeighbours(store: TaskAreaQuerier): NeighbourProvider {
  return async (task, visibleIds) => {
    try {
      const found = await findNeighbourTasks(store, {
        workspaceId: task.workspaceId,
        taskId: task.taskId,
        seedText: task.seedText,
        config: { ...TASK_AREA_FALLBACK, topK: BACKTEST_NEIGHBOUR_FETCH },
      });
      return found.map(n => n.taskId).filter(id => visibleIds.has(id));
    } catch {
      return [];
    }
  };
}
