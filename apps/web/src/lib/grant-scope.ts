/**
 * The one rule for what an account-level MCP grant session may reach.
 *
 * A grant session (an OAuth token carrying `grant_id`, lib/mcp-grants.ts)
 * authenticates as its team's shared session account, but it is confined to
 * `account.workspaceIds`: the grant's workspaces ∩ the user's CURRENT team
 * memberships, resolved on every request and never cached
 * (lib/api-auth.ts authenticateOauthJwt). Under the `x-buildd-workspace`
 * binding that list is exactly the one bound workspace. That list is the whole
 * of its reach, so:
 *
 *  - every workspace a grant session acts in must be on it, whatever the
 *    account's team or links would otherwise allow;
 *  - a workspace on it is reachable whatever its `access_mode`. A grant is an
 *    explicit per-workspace consent by a current member of that workspace's
 *    team, so it does not also need the shared team account to hold an
 *    `account_workspaces` link to a `restricted` workspace. API keys, legacy
 *    OAuth tokens and `bldt_` task tokens keep the restricted-mode rule
 *    (lib/workspace-reach.ts): this exception is for grant sessions only.
 *  - a grant without the `write` scope reads only.
 *
 * Pure, with no imports, so lib/workspace-reach.ts (itself import-free) and
 * the REST route policy can both apply it. Import this from any handler that
 * picks a workspace for a caller instead of re-deriving the rule.
 */

export type GrantAccess = 'read' | 'write';

export interface GrantScopedAccount {
  /** Set only on a grant session; null/absent for every other credential. */
  oauthGrantId?: string | null;
  /** The grant's scopes (`read`, `write`). */
  grantScopes?: readonly string[] | null;
  /** The workspaces this credential is confined to; null = not restricted. */
  workspaceIds?: readonly string[] | null;
}

/** True only for an account-level grant session. */
export function isGrantSession(account: GrantScopedAccount | null | undefined): boolean {
  return !!account && typeof account.oauthGrantId === 'string' && account.oauthGrantId.length > 0;
}

/**
 * May this account act in `workspaceId` with `access`?
 *
 * A grant session: only a workspace on its list, and a write only with the
 * `write` scope. A grant session with no list is refused outright (fail closed).
 * Any other workspace-restricted credential (a scoped API key): only a
 * workspace on its list. Everything else: true here, and the caller's usual
 * team/link rule still decides. This never widens; it can only refuse.
 */
export function assertGrantedWorkspace(
  account: GrantScopedAccount | null | undefined,
  workspaceId: string | null | undefined,
  access: GrantAccess,
): boolean {
  if (!account) return false;
  if (isGrantSession(account)) {
    if (!workspaceId || !Array.isArray(account.workspaceIds)) return false;
    if (!account.workspaceIds.includes(workspaceId)) return false;
    if (access === 'write' && !(account.grantScopes ?? []).includes('write')) return false;
    return true;
  }
  if (account.workspaceIds != null) return !!workspaceId && account.workspaceIds.includes(workspaceId);
  return true;
}

/**
 * Narrow a team-wide (or link-wide) workspace id list to what the account may
 * reach. A no-op for an unrestricted credential.
 */
export function constrainToGranted(
  account: GrantScopedAccount | null | undefined,
  workspaceIds: readonly string[],
  access: GrantAccess = 'read',
): string[] {
  if (!account) return [];
  if (!isGrantSession(account) && account.workspaceIds == null) return [...workspaceIds];
  return workspaceIds.filter((id) => assertGrantedWorkspace(account, id, access));
}
