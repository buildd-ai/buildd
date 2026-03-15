/**
 * CI Retry — Ralph Loop Integration
 *
 * Builds retry task data when a CI check suite fails on a buildd worker's PR.
 * The retry task inherits branch context, verification commands, and failure
 * metadata so the next agent attempt can pick up where the previous left off.
 */

const DEFAULT_MAX_ITERATIONS = 3;

export interface CIRetryParams {
  originalTask: {
    id: string;
    title: string;
    description: string | null;
    workspaceId: string;
    context: Record<string, unknown> | null;
  };
  worker: {
    id: string;
    branch: string;
    prNumber: number | null;
  };
  failureContext: string;
  repoFullName: string;
}

export interface CIRetryTask {
  title: string;
  description: string;
  workspaceId: string;
  parentTaskId: string;
  creationSource: 'webhook';
  context: Record<string, unknown>;
}

/**
 * Build a retry task from a CI failure event.
 *
 * Returns null if the max iteration count has been reached (prevents infinite loops).
 */
export function buildCIRetryTask(params: CIRetryParams): CIRetryTask | null {
  const { originalTask, worker, failureContext, repoFullName } = params;
  const ctx = originalTask.context || {};

  const currentIteration = typeof ctx.iteration === 'number' ? ctx.iteration : 0;
  const maxIterations = typeof ctx.maxIterations === 'number' ? ctx.maxIterations : DEFAULT_MAX_ITERATIONS;

  // Guard against infinite retry loops
  if (currentIteration >= maxIterations) {
    return null;
  }

  const nextIteration = currentIteration + 1;

  // Extract the meaningful part of the title (strip existing retry prefixes)
  const cleanTitle = originalTask.title
    .replace(/^\[CI Retry #?\d*\]\s*/i, '')
    .replace(/^retry:\s*/i, '');

  return {
    title: `[CI Retry #${nextIteration}] ${cleanTitle}`,
    description: buildRetryDescription(originalTask, failureContext, repoFullName, nextIteration, maxIterations),
    workspaceId: originalTask.workspaceId,
    parentTaskId: originalTask.id,
    creationSource: 'webhook',
    context: {
      // Branch continuity — new worker starts from previous attempt's branch
      baseBranch: worker.branch,
      // Retry metadata
      iteration: nextIteration,
      maxIterations,
      failureContext,
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
): string {
  return `CI checks failed on the PR for "${task.title}" (${repoFullName}).

**Attempt ${iteration} of ${maxIterations}.**

## CI Failure Output

\`\`\`
${failureContext}
\`\`\`

## Instructions

1. Check out the existing branch — your worktree is based on the previous attempt's work
2. Read the CI failure output above carefully
3. Fix the failing tests/build/lint issues
4. Run the verification command locally before completing
5. Push your fixes to the existing branch (the PR will auto-update)

${task.description ? `## Original Task Description\n\n${task.description}` : ''}`;
}
