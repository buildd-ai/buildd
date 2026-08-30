/**
 * CI Retry — Ralph Loop Integration
 *
 * Builds retry task data when a CI check suite fails on a buildd worker's PR.
 * The retry task inherits branch context and failure metadata so the next
 * agent attempt picks up the previous attempt's branch and fixes the failure.
 *
 * Triggered in real time by the GitHub `check_suite` failure webhook (no cron),
 * and dispatched to a connected runner via pusher.
 */

const DEFAULT_MAX_ITERATIONS = 3;

export interface CIRetryParams {
  originalTask: {
    id: string;
    title: string;
    description: string | null;
    workspaceId: string;
    context: Record<string, unknown> | null;
    missionId?: string | null;
  };
  worker: {
    id: string;
    branch: string;
    prNumber: number | null;
  };
  failureContext: string;
  repoFullName: string;
  /** GitHub Actions run id/url for the failed run — lets the agent pull scoped logs via `gh run view`. */
  ciRunId?: number | null;
  ciRunUrl?: string | null;
  /** Workspace-level max CI retries (from gitConfig.maxCiRetries). Overrides task-level maxIterations. 0 disables. */
  workspaceMaxCiRetries?: number;
  /**
   * True when the failing head SHA was pushed by someone other than the buildd worker
   * (a human, a GitHub Action, etc.). The retry task is still created so the PR gets
   * fixed, but the attempt counter is NOT incremented — the agent's budget is preserved.
   */
  foreignHeadSha?: boolean;
  /** Login/name of the non-worker commit author, recorded for forensics. */
  foreignCommitAuthor?: string;
}

export interface CIRetryTask {
  title: string;
  description: string;
  workspaceId: string;
  parentTaskId: string;
  creationSource: 'webhook';
  taskClass: 'attempt';
  missionId: string | null;
  context: Record<string, unknown>;
}

/**
 * Build a retry task from a CI failure event.
 *
 * Returns null when retries are exhausted or disabled (maxCiRetries === 0),
 * which prevents infinite retry loops.
 */
export function buildCIRetryTask(params: CIRetryParams): CIRetryTask | null {
  const { originalTask, worker, failureContext, repoFullName, ciRunId, ciRunUrl, workspaceMaxCiRetries, foreignHeadSha, foreignCommitAuthor } = params;
  const ctx = originalTask.context || {};

  const currentIteration = typeof ctx.iteration === 'number' ? ctx.iteration : 0;
  // Priority: workspace gitConfig.maxCiRetries > task context.maxIterations > default 3.
  // maxCiRetries === 0 explicitly disables CI retries for the workspace.
  const maxIterations = workspaceMaxCiRetries ?? (typeof ctx.maxIterations === 'number' ? ctx.maxIterations : DEFAULT_MAX_ITERATIONS);

  // Honor the "retries disabled" switch regardless of commit authorship.
  if (maxIterations <= 0) {
    return null;
  }

  // Foreign commits (non-worker pushes) do NOT consume a retry attempt.
  // Worker commits do consume one and must respect the exhaustion cap.
  if (!foreignHeadSha && currentIteration >= maxIterations) {
    return null;
  }

  // Foreign commits keep the same iteration so the agent's budget is preserved.
  const nextIteration = foreignHeadSha ? currentIteration : currentIteration + 1;

  // Display number always advances for readability (title and description).
  // context.iteration tracks actual agent-authored attempts.
  const displayIteration = currentIteration + 1;

  // Strip any existing retry prefix so the title doesn't accumulate them.
  const cleanTitle = originalTask.title
    .replace(/^\[CI Retry #?\d*\]\s*/i, '')
    .replace(/^retry:\s*/i, '');

  return {
    title: `[CI Retry #${displayIteration}] ${cleanTitle}`,
    description: buildRetryDescription(originalTask, failureContext, repoFullName, displayIteration, maxIterations, ciRunId ?? null, ciRunUrl ?? null, foreignHeadSha, foreignCommitAuthor),
    workspaceId: originalTask.workspaceId,
    parentTaskId: originalTask.id,
    creationSource: 'webhook',
    taskClass: 'attempt' as const,
    // Inherit missionId so the retry stays attached to the mission loop.
    missionId: originalTask.missionId ?? null,
    context: {
      // Branch continuity — the new worker's worktree starts from the previous
      // attempt's branch, so fixes land on the same PR.
      baseBranch: worker.branch,
      // Explicit continuity marker (same value; preferred over baseBranch going forward)
      resumeBranch: worker.branch,
      // Copy lastCommitSha from parent context if captured by failure-capture path
      ...(typeof ctx.lastCommitSha === 'string' ? { lastCommitSha: ctx.lastCommitSha } : {}),
      // Structured failure context (replaces bare string going forward)
      failureContext: {
        summary: failureContext,
        errorType: 'ci_failure' as const,
        ...(typeof ctx.lastCommitSha === 'string' ? { commitSha: ctx.lastCommitSha } : {}),
      },
      // Retry metadata
      iteration: nextIteration,
      maxIterations,
      // CI run reference for on-demand log pulls
      ...(ciRunId ? { ciRunId } : {}),
      ...(ciRunUrl ? { ciRunUrl } : {}),
      // Preserve verification command if set
      ...(ctx.verificationCommand ? { verificationCommand: ctx.verificationCommand } : {}),
      // PR reference
      ...(worker.prNumber ? { prNumber: worker.prNumber } : {}),
      // Skill slugs (preserve from original)
      ...(ctx.skillSlugs ? { skillSlugs: ctx.skillSlugs } : {}),
      // Provenance — records that this retry was triggered by a non-worker commit.
      // Lets mission timeline / forensics distinguish 'agent attempt N of M' from
      // 'someone else pushed; no attempt consumed'.
      ...(foreignHeadSha ? {
        foreign_head_sha: true,
        ...(foreignCommitAuthor ? { foreignCommitAuthor } : {}),
      } : {}),
    },
  };
}

function buildRetryDescription(
  task: CIRetryParams['originalTask'],
  failureContext: string,
  repoFullName: string,
  iteration: number,
  maxIterations: number,
  ciRunId: number | null,
  ciRunUrl: string | null,
  foreignHeadSha?: boolean,
  foreignCommitAuthor?: string,
): string {
  // Don't ship the full (verbose) log — point the agent at `gh run view`, which
  // returns only the failed steps' output, so it pulls just what it needs.
  const logSection = ciRunId
    ? `## Pull the failing logs (failed steps only)

\`\`\`bash
gh run view ${ciRunId} --repo ${repoFullName} --log-failed
\`\`\`
Grep or tail if the output is large — don't dump the whole thing.${ciRunUrl ? `\nRun: ${ciRunUrl}` : ''}
`
    : '';

  const foreignNote = foreignHeadSha
    ? `> **Note:** This CI failure was triggered by a commit from ${foreignCommitAuthor ? `@${foreignCommitAuthor}` : 'an external contributor'}, not the buildd agent. Your retry budget is **not consumed** by this attempt.\n\n`
    : '';

  return `CI checks failed on the PR for "${task.title}" (${repoFullName}).

**Attempt ${iteration} of ${maxIterations}.**

${foreignNote}## What failed

\`\`\`
${failureContext}
\`\`\`

${logSection}## Instructions

1. Check out the existing branch — your worktree is based on the previous attempt's work
2. ${ciRunId ? 'Pull the failing logs with the command above and read them carefully' : 'Read the failure summary above carefully'}
3. Fix the failing tests/build/lint issues
4. Run the verification command locally before completing
5. Push your fixes to the existing branch (the PR will auto-update)

${task.description ? `## Original Task Description\n\n${task.description}` : ''}`;
}
