/**
 * A PR head's CI verdict from its check suites (GET .../commits/:sha/check-suites),
 * for the stale-PR refresh (pr-state-refresh.ts via github.ts).
 *
 * A suite with no check runs carries no verdict: GitHub Apps (Vercel, for one)
 * open a suite that can stay `queued` with zero runs indefinitely, and counting
 * it held a PR at "CI running" for weeks while its real checks had failed.
 */

export type CiLifecycle = 'ci_green' | 'ci_failed' | 'ci_running';

interface Suite { status: string; conclusion: string | null; latest_check_runs_count?: number }

const PASSED = new Set(['success', 'skipped', 'neutral']);

export function ciLifecycleFromSuites(suites: readonly Suite[] | undefined | null): CiLifecycle | null {
  const real = (suites ?? []).filter(s => s.latest_check_runs_count !== 0);
  if (real.length === 0) return null;
  if (real.some(s => s.status !== 'completed')) return 'ci_running';
  return real.every(s => PASSED.has(s.conclusion ?? '')) ? 'ci_green' : 'ci_failed';
}
