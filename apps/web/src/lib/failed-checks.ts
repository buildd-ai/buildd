/**
 * The checks failing on a PR's head, by name, for get_pr: "CI failed" says
 * nothing about which job, and the next question is always which one.
 *
 * Deduplicates by check name using the same semantics as latestRunPerName in
 * auto-merge-bound.ts: when a PR body edit triggers a new workflow run on the
 * same head SHA, the new run's passing check supersedes the old run's failure.
 * Check-run ID (monotonic) or started_at determines which is newer; fails
 * closed if two runs cannot be ordered.
 */

import { latestRunPerName } from '@/lib/auto-merge-bound';

export const MAX_FAILED_CHECKS = 5;

const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

export interface FailedCheck { name: string; conclusion: string; url: string | null }

interface CheckRunInput { name?: string; status?: string; conclusion?: string | null; html_url?: string | null; details_url?: string | null; id?: number; started_at?: string | null }

export function failedChecks(runs: readonly (CheckRunInput | null | undefined)[]): FailedCheck[] {
  const complete = runs.filter((r) => r && typeof r.name === 'string' && r.status === 'completed') as CheckRunInput[];

  const asCheckRunState = complete.map(r => ({
    name: r.name!,
    status: r.status || '',
    conclusion: r.conclusion ?? null,
    id: r.id,
    started_at: r.started_at,
  }));

  const latest = latestRunPerName(asCheckRunState);

  const out: FailedCheck[] = [];
  for (const r of latest) {
    if (!r.conclusion || !FAILING.has(r.conclusion)) continue;
    const orig = complete.find(c => c.name === r.name && c.id === r.id && c.started_at === r.started_at);
    if (orig) {
      out.push({ name: r.name, conclusion: r.conclusion, url: orig.html_url ?? orig.details_url ?? null });
    }
  }
  return out.slice(0, MAX_FAILED_CHECKS);
}
