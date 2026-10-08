/**
 * The checks failing on a PR's head, by name, for get_pr: "CI failed" says
 * nothing about which job, and the next question is always which one.
 *
 * Deduplicates by check name, keeping only the latest run: a PR body edit
 * triggers a new workflow run (same head SHA), and the new run's passing check
 * supersedes the old run's failure. Check-run ID (monotonic) or started_at
 * determines which is newer; fails closed if two runs cannot be ordered.
 */

export const MAX_FAILED_CHECKS = 5;

const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

export interface FailedCheck { name: string; conclusion: string; url: string | null }

interface CheckRunInput { name?: string; status?: string; conclusion?: string | null; html_url?: string | null; details_url?: string | null; id?: number; started_at?: string | null }

interface CheckRunForDedup { name: string; id?: number; started_at?: string | null }

function isNewer(a: CheckRunForDedup, b: CheckRunForDedup): boolean | null {
  if (typeof a.id === 'number' && typeof b.id === 'number') return a.id > b.id;
  if (a.started_at && b.started_at) return Date.parse(a.started_at) > Date.parse(b.started_at);
  return null;
}

export function failedChecks(runs: readonly (CheckRunInput | null | undefined)[]): FailedCheck[] {
  const complete = runs.filter((r) => r && typeof r.name === 'string' && r.status === 'completed') as CheckRunInput[];

  // Deduplicate by check name, keeping only the latest run per name
  const latest: CheckRunInput[] = [];
  for (const run of complete) {
    const i = latest.findIndex((k) => k.name === run.name);
    if (i === -1) {
      latest.push(run);
      continue;
    }
    const newer = isNewer(
      { name: run.name, id: run.id, started_at: run.started_at },
      { name: latest[i].name, id: latest[i].id, started_at: latest[i].started_at }
    );
    if (newer === true) latest[i] = run;
    else if (newer === null) latest.push(run);
  }

  const out: FailedCheck[] = [];
  for (const r of latest) {
    if (!r.conclusion || !FAILING.has(r.conclusion)) continue;
    out.push({ name: r.name!, conclusion: r.conclusion, url: r.html_url ?? r.details_url ?? null });
  }
  return out.slice(0, MAX_FAILED_CHECKS);
}
