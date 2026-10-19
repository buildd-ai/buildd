// Client-safe: no imports.

/**
 * Who a runner belongs to, by its account, never by machine name or by whose
 * task it happens to be running. Independent of the team being viewed: a
 * personal runner that reaches another team's workspace stays personal.
 *
 *   managed:  Buildd-paid compute (`accounts.managedRunner`); shared by the team.
 *   team:     a team's own host runner key (`accounts.hostRunner`), shared.
 *   personal: a runner key minted by one person (`accounts.createdByUserId`).
 *   unknown:  none of the above recorded; shown as such, never guessed.
 */
export type RunnerClass = 'managed' | 'team' | 'personal' | 'unknown';
export const RUNNER_CLASSES: readonly RunnerClass[] = ['managed', 'team', 'personal', 'unknown'];

export interface RunnerOwnershipInput {
  managedRunner?: boolean | null;
  hostRunner?: boolean | null;
  createdByUserId?: string | null;
}

export function classifyRunnerOwnership(account: RunnerOwnershipInput | null | undefined): RunnerClass {
  if (!account) return 'unknown';
  if (account.managedRunner) return 'managed';
  if (account.hostRunner) return 'team';
  if (account.createdByUserId) return 'personal';
  return 'unknown';
}

/**
 * Whether a runner belongs in the viewer's own "Your runners" section: a
 * personal runner they created. Creator alone is not enough: a managed or
 * team-host key also records whoever minted it, but it is shared compute.
 */
export function isOwnPersonalRunner(r: { mine?: boolean | null; runnerClass?: RunnerClass }): boolean {
  return r.mine === true && r.runnerClass === 'personal';
}
