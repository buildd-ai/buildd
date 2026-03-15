/**
 * Worktree utility functions for the runner.
 *
 * Extracted from workers.ts for testability.
 */

/**
 * Resolve the git base ref for a new worktree.
 *
 * If `context.baseBranch` is set (e.g., from a retry task in the Ralph loop),
 * the worktree will be based on that branch instead of the default branch.
 * This preserves work from previous attempts.
 *
 * @param defaultBranch - The workspace's default branch (e.g., 'main')
 * @param context - The task context, which may contain `baseBranch`
 * @returns A git ref like `origin/main` or `origin/buildd/abc-fix-tests`
 */
export function resolveWorktreeBase(
  defaultBranch: string,
  context: Record<string, unknown> | undefined | null,
): string {
  const baseBranch = context?.baseBranch;
  if (baseBranch && typeof baseBranch === 'string' && baseBranch.length > 0) {
    return `origin/${baseBranch}`;
  }
  return `origin/${defaultBranch}`;
}
