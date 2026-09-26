/**
 * A task and its CI-retry attempts are one unit of work. The task's own row
 * goes terminal when its first worker opens the PR, but while a CI-fix attempt
 * is live on the same branch the work is not finished, and the page must say
 * so: the header status and Worker history both read across the lineage.
 */

/** Task statuses of a retry that is still going to touch the PR. */
const LIVE_ATTEMPT_STATUSES = new Set(['pending', 'assigned', 'in_progress']);

/**
 * The header status for a task given its CI-retry attempts. A completed task
 * whose PR is still open and has a live attempt reads `fixing_ci`; everything
 * else keeps the status the page already derived.
 */
export function lineageDisplayStatus(opts: {
  displayStatus: string;
  taskStatus: string;
  prMerged: boolean;
  prClosed: boolean;
  attemptStatuses: readonly string[];
}): string {
  if (opts.taskStatus !== 'completed' || opts.prMerged || opts.prClosed) return opts.displayStatus;
  return opts.attemptStatuses.some(s => LIVE_ATTEMPT_STATUSES.has(s)) ? 'fixing_ci' : opts.displayStatus;
}

export interface LineageWorkerRow<W> {
  worker: W;
  /** "attempt 2 · CI fix"; null when the task never needed a retry. */
  attemptLabel: string | null;
}

/**
 * Every worker that worked this task's PR: the task's own, then each CI-retry
 * attempt's (in attempt order), newest first. Attempt numbers follow "How it
 * landed": the task's own work is attempt 1, the Nth retry is attempt N+1.
 */
export function lineageWorkerHistory<W extends { id: string; createdAt: Date }>(
  own: readonly W[],
  attempts: ReadonlyArray<{ workers: readonly W[] }>,
): Array<LineageWorkerRow<W>> {
  // Same numbering as the page's lineage: only retries that got a worker count.
  const worked = attempts.filter(a => a.workers.length > 0);
  const rows: Array<LineageWorkerRow<W>> = own.map(worker => ({ worker, attemptLabel: worked.length > 0 ? 'attempt 1' : null }));
  worked.forEach((a, i) => {
    for (const worker of a.workers) rows.push({ worker, attemptLabel: `attempt ${i + 2} · CI fix` });
  });
  const seen = new Set<string>();
  return rows
    .filter(r => (seen.has(r.worker.id) ? false : (seen.add(r.worker.id), true)))
    .sort((a, b) => b.worker.createdAt.getTime() - a.worker.createdAt.getTime());
}
