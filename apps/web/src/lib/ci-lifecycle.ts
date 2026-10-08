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
 * SHA, creating a new suite. The old suite's failure must not override the new
 * suite's pass, so only the most recent completed suites (by updated_at) are
 * considered for the failure check.
 */

export type CiLifecycle = 'ci_green' | 'ci_failed' | 'ci_running';

interface Suite { status: string; conclusion: string | null; latest_check_runs_count?: number; updated_at?: string | null }

const PASSED = new Set(['success', 'skipped', 'neutral']);

export function ciLifecycleFromSuites(suites: readonly Suite[] | undefined | null): CiLifecycle | null {
  const all = suites ?? [];
  const completed = all.filter(s => s.status === 'completed');
  const unstartedEmpty = all.filter(s => s.status !== 'completed' && s.latest_check_runs_count === 0);
  const running = all.filter(s => s.status !== 'completed' && s.latest_check_runs_count !== 0);

  if (running.length > 0) return 'ci_running';

  // Filter completed suites to only the most recent ones (by updated_at).
  // When multiple suites have updated_at, keep only those at the max time.
  // This prevents old failures from overriding new passes when a PR body edit
  // triggers a new workflow run on the same head.
  let completedToJudge = completed;
  const timestampedCompleted = completed.filter(s => s.updated_at);
  if (timestampedCompleted.length > 0) {
    const maxTime = Math.max(...timestampedCompleted.map(s => Date.parse(s.updated_at!)));
    completedToJudge = completed.filter(s => !s.updated_at || Date.parse(s.updated_at) === maxTime);
  }

  if (completedToJudge.some(s => !PASSED.has(s.conclusion ?? ''))) return 'ci_failed';
  if (completed.length === 0) return null;
  return unstartedEmpty.length > 0 ? 'ci_running' : 'ci_green';
}
