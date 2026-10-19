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
 * Whether the viewer's own personal key. Class is authoritative: a managed or
 * team-host key never counts as "yours" even when the viewer minted it, and
 * another member's personal key (same team or cross-team) never does either.
 */
export function isViewersPersonalRunner(
  account: RunnerOwnershipInput | null | undefined,
  viewerUserId: string | null | undefined,
): boolean {
  return viewerUserId != null
    && classifyRunnerOwnership(account) === 'personal'
    && account?.createdByUserId === viewerUserId;
}
