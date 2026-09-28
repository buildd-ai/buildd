/**
 * The checks failing on a PR's head, by name, for get_pr: "CI failed" says
 * nothing about which job, and the next question is always which one.
 *
 * GitHub records a re-run as a new check run with the same name, so only the
 * latest run of each name counts: a job that failed and then passed on a
 * re-run is not failing, and one re-running now is not failing yet.
 */

export const MAX_FAILED_CHECKS = 5;

const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

export interface FailedCheck { name: string; conclusion: string; url: string | null }

interface CheckRun { id?: number; name?: string; status?: string; conclusion?: string | null; html_url?: string | null; details_url?: string | null }

export function failedChecks(runs: readonly (CheckRun | null | undefined)[]): FailedCheck[] {
  const latest = new Map<string, CheckRun>();
  for (const r of runs) {
    if (!r || typeof r.name !== 'string' || typeof r.id !== 'number') continue;
    const prev = latest.get(r.name);
    if (!prev || (prev.id ?? 0) < r.id) latest.set(r.name, r);
  }
  const out: FailedCheck[] = [];
  for (const r of latest.values()) {
    if (r.status !== 'completed' || !r.conclusion || !FAILING.has(r.conclusion)) continue;
    out.push({ name: r.name!, conclusion: r.conclusion, url: r.html_url ?? r.details_url ?? null });
  }
  return out.slice(0, MAX_FAILED_CHECKS);
}
