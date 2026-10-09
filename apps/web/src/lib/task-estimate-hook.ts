/**
 * The task-estimates experiment's one post-insert hook
 * (packages/core/task-estimate-source.ts; removal in
 * packages/core/TASK-ESTIMATES-REMOVAL.md). Called with the row just inserted
 * by every path that files work: POST /api/tasks (MCP create_task and chat
 * land there), plan approval (approve-plan.ts) and schedule-filed tasks
 * (cron/schedules).
 *
 * The write runs AFTER the response via `after()`, so it can neither delay
 * nor fail task creation: nothing awaits it, and its promise is caught. The
 * opt-in check (teams.task_estimates) happens inside the write, after the
 * response, so a team that has not opted in costs one team-row read there.
 *
 * The core module is imported lazily inside the run, so the callers' static
 * import graphs gain nothing.
 */

export interface CreatedTaskForEstimate {
  id: string;
  taskClass?: string | null;
}

export interface TaskEstimateHookDeps {
  write?: (taskId: string) => Promise<unknown>;
}

async function runTaskEstimate(taskId: string, deps: TaskEstimateHookDeps): Promise<void> {
  try {
    const write = deps.write ?? (await import('@buildd/core/task-estimate-source')).writeTaskEstimate;
    await write(taskId);
  } catch (err) {
    console.warn(`[task-estimate] not written for task ${taskId} (non-fatal): ${(err as Error)?.name ?? 'Error'}`);
  }
}

/**
 * Schedules the estimate write for a just-inserted work task. Returns whether
 * one was scheduled. Synchronous and never throws.
 */
export function scheduleTaskEstimate(
  task: CreatedTaskForEstimate | null | undefined,
  schedule: (fn: () => Promise<unknown>) => void,
  deps: TaskEstimateHookDeps = {},
): boolean {
  try {
    if (!task?.id || (task.taskClass ?? 'work') !== 'work') return false;
  } catch {
    return false;
  }
  const taskId = task.id;
  const run = () => runTaskEstimate(taskId, deps);
  try {
    schedule(run);
  } catch {
    // after() is unavailable outside a request scope; still never block.
    void run();
  }
  return true;
}
