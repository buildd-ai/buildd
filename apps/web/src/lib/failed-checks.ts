/**
 * The checks failing on a PR's head, by name, for get_pr: "CI failed" says
 * nothing about which job, and the next question is always which one.
 *
 * No dedupe by name: job names repeat across workflows (two `test` jobs), and
 * the check-runs endpoint already returns only the latest attempt of a re-run
 * (its default `filter=latest`).
 */

export const MAX_FAILED_CHECKS = 5;

const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

export interface FailedCheck { name: string; conclusion: string; url: string | null }

interface CheckRun { name?: string; status?: string; conclusion?: string | null; html_url?: string | null; details_url?: string | null }

export function failedChecks(runs: readonly (CheckRun | null | undefined)[]): FailedCheck[] {
  const out: FailedCheck[] = [];
  for (const r of runs) {
    if (!r || typeof r.name !== 'string' || r.status !== 'completed' || !r.conclusion || !FAILING.has(r.conclusion)) continue;
    out.push({ name: r.name, conclusion: r.conclusion, url: r.html_url ?? r.details_url ?? null });
  }
  return out.slice(0, MAX_FAILED_CHECKS);
}
