/**
 * A red CI run whose log shows the runner's infrastructure failed, not the code.
 *
 * A registry rate limit or an image pull that never completed says nothing
 * about the PR's diff, so a builder fix attempt has nothing to fix: it burns
 * the CI retry budget and puts the delivery in REPAIRING while the real cure
 * is re-running the failed jobs. `rerunIfInfraFailure` does that instead, and
 * is bounded by the run's own `run_attempt` so a persistent outage ends in the
 * normal fix path rather than looping.
 */

import { githubApi, githubApiText } from '@/lib/github';

/** Total attempts of one workflow run (the first plus re-runs) before infra is no longer trusted as the cause. */
export const MAX_INFRA_RUN_ATTEMPTS = 3;

/** Log lines that name an infrastructure fault. Specific on purpose: a test failure must never match. */
export const INFRA_SIGNATURES: ReadonlyArray<{ slug: string; pattern: RegExp }> = [
  { slug: 'registry_rate_limit', pattern: /toomanyrequests|You have reached your (pull|unauthenticated pull) rate limit|Data limit exceeded/i },
  { slug: 'image_pull_failed', pattern: /error pulling image|Error response from daemon: (pull access denied|manifest .* not found|Get "https?:\/\/[^"]*": (dial tcp|net\/http|context deadline|EOF))/i },
  { slug: 'registry_unavailable', pattern: /TLS handshake timeout|received unexpected HTTP status: 5\d\d|failed to (resolve|copy): .*(5\d\d|i\/o timeout)/i },
  { slug: 'runner_lost', pattern: /The runner has received a shutdown signal|lost communication with the server|The hosted runner encountered an error/i },
];

/** Slug of the first infrastructure signature in a job log, or null. */
export function detectInfraFailure(log: string | null | undefined): string | null {
  if (!log) return null;
  for (const { slug, pattern } of INFRA_SIGNATURES) if (pattern.test(log)) return slug;
  return null;
}

export type InfraRerunOutcome =
  | { rerun: true; signature: string; runId: number; runAttempt: number }
  | { rerun: false; reason: 'no_run' | 'not_infra' | 'attempts_exhausted' | 'rerun_failed' };

/**
 * If every failed job of the head's latest failed run matches an infra
 * signature, re-run the failed jobs. Never throws: any read or write failure
 * reports `rerun: false` and the caller falls through to its normal path.
 */
export async function rerunIfInfraFailure(
  installationId: number,
  repoFullName: string,
  headSha: string,
): Promise<InfraRerunOutcome> {
  try {
    const runs = await githubApi(installationId, `/repos/${repoFullName}/actions/runs?head_sha=${headSha}&status=failure`);
    const run = runs?.workflow_runs?.[0];
    if (typeof run?.id !== 'number') return { rerun: false, reason: 'no_run' };
    const runAttempt = typeof run.run_attempt === 'number' ? run.run_attempt : 1;

    const jobs = await githubApi(installationId, `/repos/${repoFullName}/actions/runs/${run.id}/jobs`);
    const failed: Array<{ id: number }> = (jobs?.jobs ?? []).filter(
      (j: { conclusion?: string; id?: unknown }) => j.conclusion === 'failure' && typeof j.id === 'number',
    );
    if (failed.length === 0) return { rerun: false, reason: 'not_infra' };

    let signature: string | null = null;
    for (const job of failed) {
      const slug = detectInfraFailure(await githubApiText(installationId, `/repos/${repoFullName}/actions/jobs/${job.id}/logs`));
      if (!slug) return { rerun: false, reason: 'not_infra' };
      signature ??= slug;
    }
    if (!signature) return { rerun: false, reason: 'not_infra' };
    if (runAttempt >= MAX_INFRA_RUN_ATTEMPTS) return { rerun: false, reason: 'attempts_exhausted' };

    await githubApi(installationId, `/repos/${repoFullName}/actions/runs/${run.id}/rerun-failed-jobs`, { method: 'POST' });
    return { rerun: true, signature, runId: run.id, runAttempt };
  } catch (err) {
    console.warn(`[ci-retry] infra re-run check failed for ${repoFullName}@${headSha}:`, err);
    return { rerun: false, reason: 'rerun_failed' };
  }
}
