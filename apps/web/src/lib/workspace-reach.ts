/**
 * The one rule for whether an API account (a `bld_` key, or an OAuth token,
 * which resolves to an account) may act on a workspace. Pure, with no imports,
 * so `team-access.ts` and `workspace-access.ts` can both apply it without an
 * import cycle.
 *
 * An account reaches a workspace when EITHER
 *   1. it has an explicit `accountWorkspaces` link to it carrying the requested
 *      permission (no permission requested: any link), or
 *   2. the workspace is `accessMode: 'open'` AND belongs to the account's own
 *      team.
 *
 * "Open" means open within the owning team, never across teams: another
 * team's open workspace is only reachable through an explicit link, which that
 * team's admins create. A `restricted` workspace is reachable only through a
 * link, including for the owning team's own accounts (docs/SPEC.md: restricted
 * = linked accounts only).
 */

export type WorkspacePermission = 'canClaim' | 'canCreate';

export interface ReachAccount {
  teamId: string;
}

export interface ReachWorkspace {
  teamId: string;
  accessMode: string | null | undefined;
}

export interface ReachLink {
  canClaim: boolean;
  canCreate: boolean;
}

export function accountReachesWorkspace(
  account: ReachAccount,
  workspace: ReachWorkspace,
  link: ReachLink | null | undefined,
  permission?: WorkspacePermission,
): boolean {
  if (link && (!permission || link[permission])) return true;
  return workspace.accessMode === 'open' && workspace.teamId === account.teamId;
}
