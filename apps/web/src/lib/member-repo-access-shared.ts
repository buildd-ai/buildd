/**
 * Client-safe half of member-repo-access.ts: the setting's vocabulary and the
 * one-line reasons a person sees. No DB, no GitHub, so a client component can
 * import it.
 */

export type MemberRepoAccessMode = 'off' | 'require_read';

export const MEMBER_REPO_ACCESS_MODES: readonly MemberRepoAccessMode[] = ['off', 'require_read'];

export type MemberRepoAccessReason =
  | 'off'              // setting is off: team membership is the whole check
  | 'collaborator'     // GitHub says read or higher on the workspace repo
  | 'no_github_link'   // this person has no GitHub account linked to Buildd
  | 'not_collaborator' // GitHub says none, or the user is not a collaborator
  | 'check_failed';    // could not ask GitHub (or no repo linked); fails closed

export interface MemberRepoAccessResult {
  allowed: boolean;
  reason: MemberRepoAccessReason;
  /** owner/name, when the workspace has a linked repository. */
  repoFullName?: string | null;
}

/** Absent or unrecognised reads as off. */
export function resolveMemberRepoAccessMode(gitConfig: unknown): MemberRepoAccessMode {
  if (!gitConfig || typeof gitConfig !== 'object') return 'off';
  const v = (gitConfig as Record<string, unknown>).memberRepoAccess;
  return v === 'require_read' ? 'require_read' : 'off';
}

/** The sentence shown to a member the check refuses. Null when allowed. */
export function memberRepoAccessMessage(result: MemberRepoAccessResult): string | null {
  if (result.allowed) return null;
  const repo = result.repoFullName ?? 'this workspace’s repository';
  switch (result.reason) {
    case 'no_github_link':
      return `This workspace requires GitHub access to ${repo}. Link your GitHub account to continue.`;
    case 'not_collaborator':
      return `Your GitHub account does not have read access to ${repo}.`;
    case 'check_failed':
    default:
      return `Buildd could not confirm your GitHub access to ${repo} right now. Try again shortly.`;
  }
}

/** The account-link flow: signing in with GitHub links it to the same-email user. */
export function linkGitHubUrl(returnTo: string): string {
  return `/app/auth/signin?provider=github&callbackUrl=${encodeURIComponent(returnTo)}`;
}
