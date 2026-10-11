/**
 * Tasks whose dependencies are scoped to their mission's current members.
 *
 * A mission's `[surface audit]` (the visual QA module, packages/core/surface-audit.ts)
 * waits on the mission's builder work as it is now. Its `dependsOn` is extended
 * as builder tasks are filed, so it records membership at filing time; a task
 * unlinked or moved out of the mission since must not hold it. Core owns the
 * rule because the claim gate and the "waiting on" counts are core: the claim
 * gate's SQL twin is `outsideSurfaceAuditMission` in
 * apps/web/src/app/api/workers/claim/deps-gate.ts.
 *
 * Every other task waits on every dependency it names, in any mission.
 */

/** Title prefix of a mission's auto-appended surface audit. Re-exported by surface-audit.ts. */
export const SURFACE_AUDIT_TITLE_PREFIX = '[surface audit] ';

/** True when `task` waits on its mission's current members only. */
export function hasMemberScopedDeps(task: { title?: string | null; missionId?: string | null }): boolean {
  return !!task.missionId && (task.title ?? '').startsWith(SURFACE_AUDIT_TITLE_PREFIX);
}

/**
 * Whether `dep` still holds `dependent`: always, unless `dependent` has
 * member-scoped dependencies and `dep` is not (any more) in its mission. A
 * dependency row that no longer exists is not a member either.
 */
export function dependencyHoldsTask(
  dependent: { title?: string | null; missionId?: string | null },
  dep: { missionId?: string | null } | null | undefined,
): boolean {
  if (!hasMemberScopedDeps(dependent)) return true;
  return !!dep && dep.missionId === dependent.missionId;
}
