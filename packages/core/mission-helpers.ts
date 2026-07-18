/**
 * Returns true if the task counts as a deliverable for mission progress.
 * Coordination tasks and auto-generated housekeeping titles are excluded.
 */
export function isDeliverableTask(task: {
  kind?: string | null;
  title?: string | null;
  mode?: string | null;
  creationSource?: string | null;
}): boolean {
  if (task.kind === 'coordination') return false;
  if (task.mode === 'planning') return false;
  if (task.title?.startsWith('Aggregate results:')) return false;
  if (task.title?.startsWith('Evaluate mission completion:')) return false;
  if (task.title?.startsWith('Mission:')) return false;
  if (task.title?.startsWith('Close mission')) return false;
  return true;
}

/**
 * Compute mission progress from a list of tasks.
 *
 * Rules:
 * - Only deliverable tasks (as per isDeliverableTask) count.
 * - Cancelled tasks are excluded from the denominator — they're treated as
 *   "never happened" so duplicate-killing doesn't block 100% completion.
 * - Failed tasks DO count against progress; they represent unfinished intended work.
 */
export function computeMissionProgress(tasks: Array<{
  status: string;
  kind?: string | null;
  title?: string | null;
  mode?: string | null;
  creationSource?: string | null;
}>): { totalTasks: number; completedTasks: number; progress: number } {
  const countable = tasks
    .filter(isDeliverableTask)
    .filter(t => t.status !== 'cancelled');
  const total = countable.length;
  const completed = countable.filter(t => t.status === 'completed').length;
  return {
    totalTasks: total,
    completedTasks: completed,
    progress: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}
