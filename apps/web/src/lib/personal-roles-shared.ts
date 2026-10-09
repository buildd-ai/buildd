/**
 * How the team pages present personal roles. Pure and db-free, so a client
 * component may import it and a test can exercise it without the db.
 *
 * The rules mirror the server's (`canSeeRole` / `mayEditPersonalRole` in
 * lib/personal-roles.ts and the share/promote routes): a member always sees
 * their own personal roles, sees another member's only once it is shared, and
 * never sees another member's private one. The routes stay the authority;
 * this only decides what to offer.
 */

export type RoleVisibility = 'private' | 'team';

export interface TeamLevelRowLike {
  id: string;
  slug: string;
  ownerUserId: string | null;
  visibility: string | null;
}

/**
 * Split team-level rows (workspaceId NULL) into team roles, the viewer's own
 * personal roles, and teammates' shared ones. Another member's private role
 * lands in none of them.
 */
export function splitTeamLevelRows<T extends TeamLevelRowLike>(
  rows: readonly T[],
  viewerId: string,
): { teamRoles: T[]; mine: T[]; sharedByOthers: T[] } {
  const teamRoles: T[] = [];
  const mine: T[] = [];
  const sharedByOthers: T[] = [];
  for (const row of rows) {
    if (row.ownerUserId == null) teamRoles.push(row);
    else if (row.ownerUserId === viewerId) mine.push(row);
    else if (row.visibility === 'team') sharedByOthers.push(row);
  }
  return { teamRoles, mine, sharedByOthers };
}

/** Where a personal role is edited. A slug is not unique for personal rows, so the id rides along. */
export function personalRoleEditorPath(role: { id: string; slug: string }): string {
  return `/app/settings/roles/${encodeURIComponent(role.slug)}/edit?id=${encodeURIComponent(role.id)}`;
}

export interface PersonalRoleAccess {
  /** Save, delete and the rest of the form. */
  canEdit: boolean;
  /** The share toggle (private <-> team). */
  canShare: boolean;
  /** "Make team role": shared, and the viewer manages agent roles. */
  canPromote: boolean;
}

/**
 * What the viewer may do with a personal role they can see. The owner edits
 * and shares; a `manage_agent_roles` holder may do the same once it is shared,
 * and only they may promote it (a private role must be shared first).
 */
export function personalRoleAccess(input: {
  isOwner: boolean;
  visibility: string | null;
  canManageRoles: boolean;
}): PersonalRoleAccess {
  const shared = input.visibility === 'team';
  const editor = input.isOwner || (shared && input.canManageRoles);
  return { canEdit: editor, canShare: editor, canPromote: shared && input.canManageRoles };
}

export type NewRoleKind = 'personal' | 'team';

/**
 * Which kinds the "New role" form offers: "Just for me" with
 * `create_personal_roles`, "Team role" with `manage_agent_roles`.
 */
export function newRoleKinds(perms: { createPersonal: boolean; manageTeam: boolean }): NewRoleKind[] {
  const kinds: NewRoleKind[] = [];
  if (perms.createPersonal) kinds.push('personal');
  if (perms.manageTeam) kinds.push('team');
  return kinds;
}

/** The kind the form starts on: the requested one if offered, else team, else personal. */
export function initialRoleKind(kinds: readonly NewRoleKind[], requested?: string | null): NewRoleKind | null {
  if (requested === 'personal' || requested === 'team') {
    if (kinds.includes(requested)) return requested;
  }
  if (kinds.includes('team')) return 'team';
  return kinds[0] ?? null;
}

/** The body the form posts to /api/roles for each kind. */
export function newRoleRequestBody(
  kind: NewRoleKind,
  teamId: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...fields, teamId, isRole: true };
  if (kind === 'personal') body.personal = true;
  return body;
}

/** The error text a share/promote/create response carries, or a fallback. */
export function responseErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    const msg = (data as { error: string }).error.trim();
    if (msg) return msg;
  }
  return fallback;
}
