/**
 * Returns true if a task is a real deliverable (not a coordination/housekeeping task).
 * Excludes planning-mode tasks (aggregators, evaluators) and housekeeping title patterns.
 */
export function isDeliverableTask(t: { title: string; mode?: string | null }): boolean {
  if (t.mode === 'planning') return false;
  if (t.title.startsWith('Aggregate results:')) return false;
  if (t.title.startsWith('Evaluate mission completion:')) return false;
  if (t.title.startsWith('Mission:')) return false;
  return true;
}
