/**
 * Claim-time hint for an interactive session standing on a branch that already
 * has work of its own. The task's commits would land on top of it and
 * `create_pr` would then carry both into one PR (see pr-scope.ts). The claim
 * says so and recommends the assigned branch; it never changes the session's
 * branch.
 */

export interface ClaimBranchHintInput {
  /** A verified interactive session claimed this task. */
  interactive: boolean;
  /** The branch the session is on, as it reported it. */
  sessionBranch?: string | null;
  /** Commits that branch has ahead of the task's base, as the session measured them. */
  sessionCommitsAhead?: number | null;
  /** The branch buildd assigned this task. */
  assignedBranch: string;
  /** The branch the task's PR will target. */
  base?: string | null;
}

export function claimBranchHint(i: ClaimBranchHintInput): string | null {
  if (!i.interactive) return null;
  const ahead = i.sessionCommitsAhead;
  if (typeof ahead !== 'number' || !Number.isFinite(ahead) || ahead <= 0) return null;
  const branch = i.sessionBranch?.trim();
  if (!branch || branch === i.assignedBranch) return null;
  const base = i.base ? ` ${i.base}` : ' the task\'s base';
  return `Your current branch '${branch}' already has ${ahead} commit${ahead === 1 ? '' : 's'} ahead of${base}. `
    + `Work done here would land on top of them and the PR would carry them too. `
    + `Start from the assigned branch '${i.assignedBranch}' (a fresh branch from${base}) instead; buildd has not changed your branch.`;
}
