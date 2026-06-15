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
