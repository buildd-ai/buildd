/**
 * GitHub Actions CI-failure inspection.
 *
 * Extracted from the `check_suite` webhook handler so a second caller (the
 * manual "fix CI" action on a red PR) can classify and describe a failure
 * exactly the same way the automatic retry path does, instead of growing a
 * second, slightly-different reader of the same GitHub API.
 */

import { githubApi, githubApiText } from '@/lib/github';
import { extractFailureDigest } from '@/lib/ci-failure-digest';

export interface CIFailureInfo {
  /** Failed-job/step summary plus the extracted failure digest, or null. */
  summary: string | null;
  /** Actions run ID. */
  runId: number | null;
  runUrl: string | null;
  /**
   * Id of the first failed job. The retry instruction needs it to name a log
   * endpoint that returns content; without it the agent has to list jobs first.
   */
  failedJobId: number | null;
  /**
   * Display `name` of every failed job in the run (e.g. "Schema Drift /
   * check-prod"). Drives failure classification (see `ci-drift-diagnose.ts`)
   * — the check name is the only reliable signal available here, since the
   * webhook payload carries no structured failure reason.
   */
  failedJobNames: string[];
}


/** Check if a PR is a draft via the GitHub API. Fails open (returns false). */
export async function checkPrIsDraft(
  installationId: number,
  repoFullName: string,
  prNumber: number,
): Promise<boolean> {
  try {
    const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
    return pr?.draft === true;
  } catch (error) {
    console.warn(`Failed to check draft status for PR #${prNumber} on ${repoFullName}:`, error);
    return false;
  }
}

/**
 * Draft + open/closed state in one read, for the CI-retry gate. Fails open like
 * `checkPrIsDraft`: a failed read reports an open, non-draft PR, and a response
 * without `state` is treated as open.
 */
export async function fetchPrRetryGate(
  installationId: number,
  repoFullName: string,
  prNumber: number,
): Promise<{ draft: boolean; closed: boolean; merged: boolean }> {
  try {
    const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
    return {
      draft: pr?.draft === true,
      closed: typeof pr?.state === 'string' && pr.state !== 'open',
      merged: pr?.merged === true,
    };
  } catch (error) {
    console.warn(`Failed to read PR #${prNumber} on ${repoFullName} for the CI-retry gate:`, error);
    return { draft: false, closed: false, merged: false };
  }
}

// Commit author identity is deliberately not read here: whose push a head is
// is decided by provenance (SHA sets, docs/specs/workflow-state-kernel.md §6.9),
// and the CI budget is spent at dispatch (§5.7), never by author string.

// Fetch failed-job/step names from GitHub Actions for actionable retry context.
// Returns the failing-step summary plus the run id/url so the agent can pull the
// scoped logs itself (`gh run view <id> --log-failed`) rather than us shipping
// the full, verbose log down. Fields are null/empty when nothing can be fetched.
export async function fetchCIFailureLogs(
  installationId: number,
  repoFullName: string,
  headSha: string,
): Promise<CIFailureInfo> {
  const empty: CIFailureInfo = { summary: null, runId: null, runUrl: null, failedJobId: null, failedJobNames: [] };
  try {
    const runsData = await githubApi(
      installationId,
      `/repos/${repoFullName}/actions/runs?head_sha=${headSha}&status=failure`,
    );
    if (!runsData?.workflow_runs?.length) {
      return empty;
    }

    const run = runsData.workflow_runs[0];
    const runId = typeof run.id === 'number' ? run.id : null;
    const runUrl = typeof run.html_url === 'string' ? run.html_url : null;

    const jobsData = await githubApi(
      installationId,
      `/repos/${repoFullName}/actions/runs/${run.id}/jobs`,
    );
    if (!jobsData?.jobs?.length) {
      return { summary: null, runId, runUrl, failedJobId: null, failedJobNames: [] };
    }

    const failedJobs: string[] = [];
    const failedJobNames: string[] = [];
    let firstFailedJobId: number | null = null;
    for (const job of jobsData.jobs) {
      if (job.conclusion === 'failure') {
        if (firstFailedJobId === null && typeof job.id === 'number') firstFailedJobId = job.id;
        if (typeof job.name === 'string') failedJobNames.push(job.name);
        const failedSteps = (job.steps || [])
          .filter((s: { conclusion?: string }) => s.conclusion === 'failure')
          .map((s: { name?: string }) => `  - Step "${s.name}" failed`)
          .join('\n');
        failedJobs.push(`Job "${job.name}" failed${failedSteps ? ':\n' + failedSteps : ''}`);
      }
    }
    if (failedJobs.length === 0) {
      return { summary: null, runId, runUrl, failedJobId: null, failedJobNames: [] };
    }

    // Job and step names alone told a cold-start retry agent that "Run tests"
    // failed and nothing more. Carry the actual digest — the failing file and
    // test names — so the retry starts from the failure instead of rediscovering
    // it. One job only, and the extractor caps what it returns.
    let digest: string | null = null;
    if (firstFailedJobId !== null) {
      try {
        const log = await githubApiText(
          installationId,
          `/repos/${repoFullName}/actions/jobs/${firstFailedJobId}/logs`,
        );
        digest = extractFailureDigest(log);
      } catch (err) {
        // Soft: the job/step summary below is still worth shipping, and a retry
        // task with a thinner description beats no retry task.
        console.warn(`Could not read job log ${firstFailedJobId} for ${repoFullName}:`, err);
      }
    }

    const digestSection = digest ? `\n\n${digest}` : '';
    return {
      summary: `CI failed on ${repoFullName} (run: ${runUrl})\n\n${failedJobs.join('\n\n')}${digestSection}`,
      runId,
      runUrl,
      failedJobId: firstFailedJobId,
      failedJobNames,
    };
  } catch (error) {
    console.warn(`Failed to fetch CI logs for ${repoFullName}@${headSha}:`, error);
    return empty;
  }
}
