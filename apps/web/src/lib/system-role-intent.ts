import { isSystemRoleSlug } from '@buildd/shared';

/**
 * A request to write a task for a system-only role (today the visual auditor)
 * through generic task creation: the composer's `?roleSlug=` / `?skillSlug=`,
 * or chat's create_task. A visual review is a mission command, so:
 * - with a mission: send the person to that mission's Visual review;
 * - without one: say it is mission-scoped, and file nothing.
 * Client-safe.
 */
export type SystemRoleIntent =
  | { kind: 'mission'; missionId: string; href: string }
  | { kind: 'no_mission' };

/** The mission page with its Visual review sheet open. */
export function missionVisualReviewHref(missionId: string): string {
  return `/app/missions/${encodeURIComponent(missionId)}?visualReview=1`;
}

export function systemRoleIntent(input: {
  roleSlug?: string | null;
  skillSlug?: string | null;
  missionId?: string | null;
}): SystemRoleIntent | null {
  if (!isSystemRoleSlug(input.roleSlug) && !isSystemRoleSlug(input.skillSlug)) return null;
  const missionId = input.missionId?.trim();
  return missionId
    ? { kind: 'mission', missionId, href: missionVisualReviewHref(missionId) }
    : { kind: 'no_mission' };
}

export const VISUAL_REVIEW_IS_MISSION_SCOPED =
  'A visual review belongs to a mission: it checks the screens that mission changed. Open the mission and use Visual review there. No task was created.';
