/**
 * A PR whose CI-fix chain has ended with the checks still red.
 *
 * The last `[builder · after CI #N]` attempt completing is not the PR being
 * fixed: the attempt can finish while the PR's gating checks are red. Reading
 * that as "done" is how an exhausted chain rendered as READY FOR REVIEW.
 */

const CI_ATTEMPT_TITLE = /^\[builder · after CI #(\d+)\]/;
const FAILED_JOB = /Job "([^"]+)" failed/g;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled']);

/** Most failing checks a card names before it stops listing them. */
export const CI_RED_FAILING_NAMED = 3;

export interface CiRedChain {
  /** The task that owns the PR (the attempts' parent). */
  taskId: string;
  prNumber: number;
  /** Highest CI-fix attempt ordinal that ran. */
  attempts: number;
  /** Failing checks named by the latest attempt's failure summary; empty when unknown. */
  failing: string[];
}

export function ciAttemptOrdinal(title: string | null | undefined): number | null {
  const m = title?.match(CI_ATTEMPT_TITLE);
  return m ? Number(m[1]) : null;
}

export function failingJobsFromSummary(summary: unknown): string[] {
  if (typeof summary !== 'string') return [];
  const names: string[] = [];
  for (const m of summary.matchAll(FAILED_JOB)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names.slice(0, CI_RED_FAILING_NAMED);
}

export interface CiChainTask {
  id: string;
  title: string;
  status: string;
  context?: Record<string, unknown> | null;
  workers?: Array<{ prNumber?: number | null }> | null;
}

function attemptPr(t: CiChainTask): number | null {
  const fromContext = t.context?.prNumber;
  if (typeof fromContext === 'number') return fromContext;
  const w = t.workers?.find(x => typeof x.prNumber === 'number');
  return w?.prNumber ?? null;
}

/**
 * The chain for one PR, or null when there is nothing exhausted to report.
 * Requires the owner's PR lifecycle to be `ci_failed`, at least one CI-fix
 * attempt for that PR, and no attempt still open (an open one means the
 * platform owes the next push).
 */
export function deriveCiRedChain(input: {
  pr: { taskId: string; prNumber: number };
  prLifecycleStatus: string | null | undefined;
  tasks: readonly CiChainTask[];
}): CiRedChain | null {
  if (input.prLifecycleStatus !== 'ci_failed') return null;
  const attempts = input.tasks
    .map(t => ({ t, n: ciAttemptOrdinal(t.title) }))
    .filter((a): a is { t: CiChainTask; n: number } => a.n !== null && attemptPr(a.t) === input.pr.prNumber);
  if (attempts.length === 0) return null;
  if (attempts.some(a => !TERMINAL.has(a.t.status))) return null;
  const latest = attempts.reduce((best, a) => (a.n >= best.n ? a : best));
  const failure = latest.t.context?.failureContext as { summary?: unknown } | undefined;
  return {
    taskId: input.pr.taskId,
    prNumber: input.pr.prNumber,
    attempts: latest.n,
    failing: failingJobsFromSummary(failure?.summary),
  };
}

export interface CiChainRow extends Omit<CiChainTask, 'workers'> {
  parentTaskId?: string | null;
  workers?: Array<{ prNumber?: number | null; prLifecycleStatus?: string | null }> | null;
}

/**
 * Chains for the given unmerged PRs, read from loaded task rows: the owner row
 * carries the PR lifecycle (the webhook stamps it there only) and its CI-fix
 * attempts are the rows whose `parentTaskId` is that owner.
 */
export function deriveCiRedChains(
  prs: ReadonlyArray<{ taskId: string; prNumber: number | null }>,
  tasks: readonly CiChainRow[],
): CiRedChain[] {
  const out: CiRedChain[] = [];
  for (const pr of prs) {
    if (pr.prNumber == null) continue;
    const owner = tasks.find(t => t.id === pr.taskId);
    const lifecycle = owner?.workers?.find(w => w.prNumber === pr.prNumber && w.prLifecycleStatus != null)?.prLifecycleStatus;
    const chain = deriveCiRedChain({
      pr: { taskId: pr.taskId, prNumber: pr.prNumber },
      prLifecycleStatus: lifecycle,
      tasks: tasks.filter(t => t.parentTaskId === pr.taskId),
    });
    if (chain) out.push(chain);
  }
  return out;
}
