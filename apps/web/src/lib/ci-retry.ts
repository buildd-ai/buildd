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
}

export interface CIRetryTask {
  title: string;
  description: string;
  workspaceId: string;
  parentTaskId: string;
  creationSource: 'webhook';
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
  const { originalTask, worker, failureContext, repoFullName, ciRunId, ciRunUrl, workspaceMaxCiRetries } = params;
  const ctx = originalTask.context || {};

  const currentIteration = typeof ctx.iteration === 'number' ? ctx.iteration : 0;
  // Priority: workspace gitConfig.maxCiRetries > task context.maxIterations > default 3.
  // maxCiRetries === 0 explicitly disables CI retries for the workspace.
  const maxIterations = workspaceMaxCiRetries ?? (typeof ctx.maxIterations === 'number' ? ctx.maxIterations : DEFAULT_MAX_ITERATIONS);

  // Guard against infinite retry loops (and honor the disable switch).
  if (maxIterations <= 0 || currentIteration >= maxIterations) {
    return null;
  }

  const nextIteration = currentIteration + 1;

  // Strip any existing retry prefix so the title doesn't accumulate them.
  const cleanTitle = originalTask.title
    .replace(/^\[CI Retry #?\d*\]\s*/i, '')
    .replace(/^retry:\s*/i, '');

  return {
    title: `[CI Retry #${nextIteration}] ${cleanTitle}`,
    description: buildRetryDescription(originalTask, failureContext, repoFullName, nextIteration, maxIterations, ciRunId ?? null, ciRunUrl ?? null),
    workspaceId: originalTask.workspaceId,
    parentTaskId: originalTask.id,
    creationSource: 'webhook',
    // Inherit missionId so the retry stays attached to the mission loop.
    missionId: originalTask.missionId ?? null,
    context: {
      // Branch continuity — the new worker's worktree starts from the previous
      // attempt's branch, so fixes land on the same PR.
      baseBranch: worker.branch,
      // Retry metadata
      iteration: nextIteration,
      maxIterations,
      failureContext,
      // CI run reference for on-demand log pulls
      ...(ciRunId ? { ciRunId } : {}),
      ...(ciRunUrl ? { ciRunUrl } : {}),
      // Preserve verification command if set
      ...(ctx.verificationCommand ? { verificationCommand: ctx.verificationCommand } : {}),
      // PR reference
      ...(worker.prNumber ? { prNumber: worker.prNumber } : {}),
      // Skill slugs (preserve from original)
      ...(ctx.skillSlugs ? { skillSlugs: ctx.skillSlugs } : {}),
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

  return `CI checks failed on the PR for "${task.title}" (${repoFullName}).

**Attempt ${iteration} of ${maxIterations}.**

## What failed

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
