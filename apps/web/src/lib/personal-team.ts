/**
 * What makes a team a user's personal team: `teams.personal_user_id`, set
 * once at sign-up (apps/web/src/auth.ts). The slug is a display handle and
 * never decides it.
 *
 * The `personal-` slug prefix stays reserved for the slug sign-up gives a
 * personal team, so create and rename refuse it ({@link isReservedTeamSlug}).
 *
 * Pure and client-safe: no DB import.
 */

export const PERSONAL_TEAM_SLUG_PREFIX = 'personal-';

/** The slug sign-up gives a new user's personal team. */
export function personalTeamSlug(userId: string): string {
  return `${PERSONAL_TEAM_SLUG_PREFIX}${userId}`;
}

/** True when a team-chosen slug would use the reserved prefix. */
export function isReservedTeamSlug(slug: string): boolean {
  return slug.startsWith(PERSONAL_TEAM_SLUG_PREFIX);
}

export const RESERVED_TEAM_SLUG_ERROR = `Team slugs starting with "${PERSONAL_TEAM_SLUG_PREFIX}" are reserved`;

type PersonalMarker = { personalUserId?: string | null };

/** Is this any user's personal team? */
export function isPersonalTeam(team: PersonalMarker | null | undefined): boolean {
  return !!team?.personalUserId;
}

/** Is this `userId`'s own personal team? */
export function isPersonalTeamOf(team: PersonalMarker | null | undefined, userId: string): boolean {
  return !!team?.personalUserId && team.personalUserId === userId;
}
