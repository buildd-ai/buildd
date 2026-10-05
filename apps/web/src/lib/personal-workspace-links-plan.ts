/**
 * The pure rule behind {@link ./personal-workspace-links}: which
 * `accountWorkspaces` links a user's own new runner account gets in their
 * personal team. Imports only the pure reach rule, so the claim-route tests and client code can use
 * it without pulling the DB.
 */
import { accountReachesWorkspace } from './workspace-reach';

/** The slug sign-in gives a new user's personal team (apps/web/src/auth.ts). */
export function personalTeamSlug(userId: string): string {
  return `personal-${userId}`;
}

export interface PersonalLinkInput {
  userId: string;
  /** The user's role on the account's team, or null when not a member. */
  role: string | null;
  team: { id: string; slug: string };
  account: { id: string; type: string; teamId: string; workspaceIds?: string[] | null };
  teamWorkspaces: ReadonlyArray<{ id: string; teamId: string; accessMode: string | null }>;
  /** Workspaces the account is already linked to. */
  existingLinks?: ReadonlyArray<string>;
}

export interface PlannedLink {
  accountId: string;
  workspaceId: string;
  canClaim: true;
  canCreate: true;
}

/**
 * Which links to add. Empty unless every one of these holds:
 *   - the team is the user's personal team (slug `personal-<userId>`) and the
 *     user owns it;
 *   - the account is a `user` account in that same team;
 *   - the account is not a workspace-scoped token (its own list decides);
 * and then only restricted workspaces of that team without a link yet. An
 * open workspace already admits same-team accounts, so it needs none.
 */
export function planPersonalWorkspaceLinks(input: PersonalLinkInput): PlannedLink[] {
  const { userId, role, team, account, teamWorkspaces } = input;
  if (team.slug !== personalTeamSlug(userId)) return [];
  if (role !== 'owner') return [];
  if (account.type !== 'user' || account.teamId !== team.id) return [];
  if (account.workspaceIds != null) return [];
  const existing = new Set(input.existingLinks ?? []);
  return teamWorkspaces
    // Only where the account cannot already reach the workspace without a
    // link (i.e. not an open workspace of its own team).
    .filter((w) => w.teamId === team.id && !existing.has(w.id) && !accountReachesWorkspace(account, w, null))
    .map((w) => ({ accountId: account.id, workspaceId: w.id, canClaim: true, canCreate: true }));
}
