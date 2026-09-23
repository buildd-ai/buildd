/**
 * The account level an OAuth session acts at, from the caller's team role
 * (role order owner > admin > member, see team-access.ts): owner|admin →
 * admin, member → worker. A missing or unrecognised role is worker — this
 * never answers admin by default.
 *
 * Shared by authenticateApiKey (which applies it) and the OAuth consent page
 * (which tells the user what access they are granting).
 */
export function levelForTeamRole(role: string | null | undefined): 'admin' | 'worker' {
  return role === 'owner' || role === 'admin' ? 'admin' : 'worker';
}
