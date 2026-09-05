/**
 * BRANCH NAMING CONTRACT
 *
 * The single source of truth for the git branch a task's worker checks out.
 *
 * The claim route (`api/workers/claim/route.ts`) is the only writer of
 * `workers.branch`, so whatever it computes here IS the branch that exists.
 * Anything that needs that name before the worker exists — `approve-plan.ts`
 * resolving a plan step's stacked `baseBranch` ref — must call this function
 * rather than re-deriving the rule. It used to hand-mirror it and drifted:
 * the copy omitted `useBuildBranch` (so a workspace with both a `branchPrefix`
 * and `useBuildBranch` got a `<prefix>…` ref while the claim route created a
 * `buildd/…` one) and omitted the shared mission-branch override entirely.
 * A predicted ref that never exists is not a loud failure — the runner just
 * fetches `origin/<ref>`, misses, and silently starts fresh from the default
 * branch, which is the stacked-branch mechanism quietly not working.
 */

/** The subset of `workspaces.gitConfig` that decides a branch name. */
export interface BranchNameGitConfig {
  branchingStrategy?: 'none' | 'trunk' | 'gitflow' | 'feature' | 'custom' | string;
  branchPrefix?: string;
  useBuildBranch?: boolean;
}

export interface TaskBranchNameInput {
  /** The task's UUID — the first 8 chars go into the branch name. */
  taskId: string;
  /** The task title, sanitized into the branch slug. */
  title: string;
  /** `workspaces.gitConfig`, or null/undefined for repo defaults. */
  gitConfig?: BranchNameGitConfig | null;
  /**
   * A shared branch all of a mission's tasks push to, read from
   * `context.headBranch` (seeded from `missions.workingBranch`). When present
   * it wins outright: the task is not given a branch of its own.
   */
  sharedHeadBranch?: unknown;
}

/** Title → branch slug: lowercase, non-alphanumerics collapsed to `-`, 30 chars. */
export function sanitizeBranchTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .substring(0, 30);
}

/**
 * The branch name a task's worker will check out.
 *
 * Precedence (must stay identical to the claim route's insert):
 *   1. `sharedHeadBranch` — the mission's shared working branch.
 *   2. `branchingStrategy === 'none'` → `task-<id8>` (no slug at all).
 *   3. `useBuildBranch` → `buildd/<id8>-<slug>`, outranking `branchPrefix`.
 *   4. `branchPrefix` → `<prefix><id8>-<slug>`.
 *   5. default → `buildd/<id8>-<slug>`.
 */
export function generateTaskBranchName(input: TaskBranchNameInput): string {
  const { taskId, title, gitConfig, sharedHeadBranch } = input;

  if (typeof sharedHeadBranch === 'string' && sharedHeadBranch.length > 0) {
    return sharedHeadBranch;
  }

  const taskIdShort = taskId.substring(0, 8);
  if (gitConfig?.branchingStrategy === 'none') return `task-${taskIdShort}`;

  const slug = sanitizeBranchTitle(title);
  if (gitConfig?.useBuildBranch) return `buildd/${taskIdShort}-${slug}`;
  if (gitConfig?.branchPrefix) return `${gitConfig.branchPrefix}${taskIdShort}-${slug}`;
  return `buildd/${taskIdShort}-${slug}`;
}
