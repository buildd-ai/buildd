/**
 * The requester rule for personal credentials. Pure, client-safe.
 *
 * The requester is the person the work is for: chat's signed-in user, or a
 * task's requester as `resolveTaskRequesterUserId` (../task-requester) walks it
 * (the task's author, else its parent's, else the mission's or schedule's
 * creator). `null` means team work: schedules, webhooks, cron, grading.
 *
 * A personal credential (`secrets.user_id` set) is eligible only when its
 * owner IS the requester. Never for work with no requester, and never for a
 * different person, whichever account makes the call.
 */

/** Blank or missing ⇒ no requester. */
export function normalizeRequester(requesterUserId: string | null | undefined): string | null {
  return typeof requesterUserId === 'string' && requesterUserId.trim() !== '' ? requesterUserId : null;
}

export function hasRequester(requesterUserId: string | null | undefined): boolean {
  return normalizeRequester(requesterUserId) !== null;
}

/**
 * May a row owned by `rowUserId` serve this requester? A team row
 * (`rowUserId` null) is not a personal row; this answers false for it, and the
 * caller handles team rows through the policy instead.
 */
export function personalRowEligible(rowUserId: string | null | undefined, requesterUserId: string | null | undefined): boolean {
  const requester = normalizeRequester(requesterUserId);
  return !!rowUserId && requester !== null && rowUserId === requester;
}
