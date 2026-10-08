/**
 * A PR head's CI verdict from its check suites (GET .../commits/:sha/check-suites),
 * for the stale-PR refresh (pr-state-refresh.ts via github.ts).
 *
 * An unstarted suite with no check runs can't hide a failure: GitHub Apps
 * (Vercel, for one) open a suite that can stay `queued` with zero runs
 * indefinitely, and counting it as running held a PR at "CI running" for weeks
 * while its real checks had failed. It can't prove green either: an Actions run
 * held behind a concurrency group is also queued with no runs yet. A completed
 * suite always counts, whatever its run count (a workflow file that fails to
 * parse fails before any job exists).
 *
 * When a PR body is edited, a new workflow run is triggered on the same head
 * SHA, creating a new suite per workflow. The old suite's failure must not
 * override the new suite's pass, so we deduplicate per workflow/app, keeping
 * only the newest suite per app. A pass on one workflow never masks a failure
 * on another.
 */

export type CiLifecycle = 'ci_green' | 'ci_failed' | 'ci_running';

interface Suite {
  status: string;
  conclusion: string | null;
  latest_check_runs_count?: number;
  updated_at?: string | null;
  app?: { id?: number } | null;
  workflow_run?: { id?: number } | null;
}

const PASSED = new Set(['success', 'skipped', 'neutral']);

function isNewer(a: Suite, b: Suite): boolean | null {
  const aWorkflowId = a.workflow_run?.id;
  const bWorkflowId = b.workflow_run?.id;
  if (typeof aWorkflowId === 'number' && typeof bWorkflowId === 'number' && aWorkflowId !== bWorkflowId) return null;
  if (a.updated_at && b.updated_at) return Date.parse(a.updated_at) > Date.parse(b.updated_at);
  return null;
}

export function latestSuitePerApp<T extends Suite>(suites: T[]): T[] {
  const kept: T[] = [];
  for (const suite of suites) {
    const workflowId = suite.workflow_run?.id;
    const i = kept.findIndex((k) => k.workflow_run?.id === workflowId);
    if (i === -1) {
      kept.push(suite);
      continue;
    }
    const newer = isNewer(suite, kept[i]);
    if (newer === true) kept[i] = suite;
    else if (newer === null) kept.push(suite);
  }
  return kept;
}

export function ciLifecycleFromSuites(suites: readonly Suite[] | undefined | null): CiLifecycle | null {
  const all = suites ?? [];
  const completed = all.filter(s => s.status === 'completed');
  const unstartedEmpty = all.filter(s => s.status !== 'completed' && s.latest_check_runs_count === 0);
  const running = all.filter(s => s.status !== 'completed' && s.latest_check_runs_count !== 0);

  if (running.length > 0) return 'ci_running';

  const completedToJudge = latestSuitePerApp(completed);
  if (completedToJudge.some(s => !PASSED.has(s.conclusion ?? ''))) return 'ci_failed';
  if (completed.length === 0) return null;
  return unstartedEmpty.length > 0 ? 'ci_running' : 'ci_green';
}
