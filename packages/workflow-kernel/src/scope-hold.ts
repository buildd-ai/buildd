/**
 * The hold a held mission scope decision puts on its task (docs/specs/
 * workflow-kernel-library.md §6 "Scope amendments"): the claim gate's
 * single-task hold (`context.heldBy`), naming the mission whose scope it waits
 * on. Pure, so a door can tell a scope hold from a person's own before it asks
 * the kernel to record an answer.
 */

/** Why the task waits on a person. */
export const SCOPE_HOLD_REASON = 'mission_scope_decision';

/** The hold a held decision of mission `missionId` puts on its task. */
export function scopeHold(missionId: string, at: string) {
  return { at, userId: null, reason: SCOPE_HOLD_REASON, missionId };
}

/**
 * Is `heldBy` the hold mission `missionId`'s scope decision placed? A person's own hold never is,
 * and neither is one another mission's decision placed. A scope hold that names no mission
 * predates holds naming theirs and is taken as the one being answered.
 */
export function isOwnScopeHold(heldBy: unknown, missionId: string): boolean {
  if (!heldBy || typeof heldBy !== 'object') return false;
  const h = heldBy as Record<string, unknown>;
  return h.reason === SCOPE_HOLD_REASON && (h.missionId == null || h.missionId === missionId);
}
