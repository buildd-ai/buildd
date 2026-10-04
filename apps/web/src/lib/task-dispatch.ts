/**
 * Compatibility names for the pre-outbox dispatch functions. Each one is now a
 * cause-labelled wake through the dispatch authority (lib/dispatch-authority.ts);
 * none of them sends anything directly. Being removed call site by call site
 * in favour of `wakeTask` / `announceTaskCreated` — do not add new callers.
 */
import type { DispatchCause } from '@buildd/core/dispatch-outbox';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import type { DispatchTask, DispatchWorkspace, TaskDispatchEvent } from '@/lib/task-dispatch-delivery';

export {
  buildTaskPayload,
  buildWebhookPayload,
  dispatchResumedTask,
  dispatchToWebhook,
  WEBHOOK_DISPATCH_TIMEOUT_MS,
  type DispatchTask,
  type DispatchWorkspace,
  type TaskDispatchEvent,
  type TaskWebhookPayload,
} from '@/lib/task-dispatch-delivery';

/** @deprecated `announceTaskCreated` + `wakeTask(id, cause)`. */
export async function dispatchNewTask(
  task: DispatchTask,
  workspace: DispatchWorkspace,
  options?: { assignToLocalUiUrl?: string; runnerPreference?: string; cause?: DispatchCause },
): Promise<void> {
  await announceTaskCreated(task, workspace);
  await wakeTask(task.id, options?.cause ?? 'task.created', { targetLocalUiUrl: options?.assignToLocalUiUrl });
}

/** @deprecated `wakeTask(id, 'dependency.satisfied' | 'manual.start' | ...)`. */
export async function dispatchUnblockedTask(
  task: DispatchTask,
  _workspace: DispatchWorkspace,
  options?: { event?: TaskDispatchEvent; cause?: DispatchCause },
): Promise<void> {
  const cause = options?.cause ?? (options?.event === 'task.retry' ? 'manual.start' : options?.event === 'task.created' ? 'plan_child.ready' : 'dependency.satisfied');
  await wakeTask(task.id, cause);
}

/** @deprecated `wakeTask(id, 'task.requeued' | 'task.reassigned')`. */
export async function dispatchRetriedTask(
  task: DispatchTask & { startAt?: Date | string | null },
  _workspace: DispatchWorkspace,
  options?: { cause?: DispatchCause },
): Promise<void> {
  await wakeTask(task.id, options?.cause ?? 'task.requeued');
}

/** @deprecated `wakeTask(id, 'plan_child.ready')`. */
export async function dispatchPlanChildTask(task: DispatchTask, _workspace: DispatchWorkspace): Promise<void> {
  await wakeTask(task.id, 'plan_child.ready');
}
