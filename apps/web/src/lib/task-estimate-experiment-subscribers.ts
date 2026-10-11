/**
 * Task-estimates experiment (packages/core/task-estimate-actuals-source.ts;
 * removal in packages/core/TASK-ESTIMATES-REMOVAL.md): when a task completes,
 * or its PR merges after it completed, store what it actually took next to its
 * frozen estimate. The merge event matters because wall time ends at the merge,
 * which usually lands after the worker's own completion.
 *
 * Both events run the same idempotent upsert, which does nothing for a task
 * without an estimate. The core module is imported lazily, so the composition
 * root's import graph gains nothing, and it never throws.
 */
import { subscriber, type AnySubscriber } from '@/lib/core-events';

export interface RecordActualsDeps {
  record?: (taskId: string) => Promise<unknown>;
}

export async function recordActualsFor(taskId: string, taskClass: string | null | undefined, deps: RecordActualsDeps = {}): Promise<void> {
  if ((taskClass ?? 'work') !== 'work') return;
  const record = deps.record ?? (await import('@buildd/core/task-estimate-actuals-source')).recordTaskActuals;
  await record(taskId);
}

export const taskEstimateExperimentSubscribers: readonly AnySubscriber[] = [
  // task.completed carries no class; the recorder skips a non-work task itself.
  subscriber('experiments', 'task.completed', 'task-estimate-actuals-completed', e => recordActualsFor(e.taskId, null)),
  subscriber('experiments', 'task.pr_merged', 'task-estimate-actuals-merged', e => recordActualsFor(e.taskId, e.taskClass)),
];
