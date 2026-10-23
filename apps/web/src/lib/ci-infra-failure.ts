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
import { detectInfraFailure } from '@/lib/red-check-cause';

// The signatures live with the rest of the red-check rules, which Home reads too.
export { INFRA_SIGNATURES, detectInfraFailure } from '@/lib/red-check-cause';

/** Total attempts of one workflow run (the first plus re-runs) before infra is no longer trusted as the cause. */
export const MAX_INFRA_RUN_ATTEMPTS = 3;

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
