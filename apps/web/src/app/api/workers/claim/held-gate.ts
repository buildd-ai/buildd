import { sql, eq, and, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, missions } from '@buildd/core/db/schema';
import { BYPASS_HELD_GATE_KEY, bypassFlagCondition } from '@/lib/bypass-flags';

/**
 * Context key set by /api/tasks/[id]/start when forceOverride=true and the task
 * has a missionId. The claim route reads this flag to bypass the held gate for
 * a single force-started task even when its parent mission is held.
 */
export { BYPASS_HELD_GATE_KEY };

/**
 * Held-mission gate for the claim route.
 *
 * Returns a SQL condition that is TRUE when the task's mission is not held:
 *
 *   - No missionId → always claimable.
 *   - missionId but mission.isHeld = false → claimable.
 *   - missionId and mission.isHeld = true → NOT claimable.
 *
 * Exception: context.bypassHeldGate = 'true' stamps the task as exempt
 * (set by the /start route when forceOverride=true). This allows force-starting
 * a single task even when the parent mission is held.
 */
export function missionNotHeld(): SQL {
  // The bypass arm is coalesced so the whole expression is two-valued: a bare
  // `context->>'bypassHeldGate' = 'true'` is NULL when the key is absent, which
  // made a held mission's gate NULL rather than FALSE and the explicit-claim
  // probe unable to name it (friction cad81659).
  return sql`(
    ${tasks.missionId} IS NULL
    OR ${bypassFlagCondition(tasks.context, BYPASS_HELD_GATE_KEY)}
    OR NOT EXISTS (
      SELECT 1 FROM ${missions} m
      WHERE m.id = ${tasks.missionId}
      AND m.is_held = true
    )
  )`;
}

/**
 * Context key a single-task hold writes (PATCH /api/tasks/[id] `{ held: true }`,
 * e.g. "pause checkout until the rounding decision is in" from chat). Its value
 * is `{ at, userId, reason? }`; resuming removes the key.
 */
export const TASK_HOLD_KEY = 'heldBy' as const;

/**
 * Held-task gate for the claim route: TRUE when the task itself carries no
 * hold. Independent of the mission gate above — a held task under an armed
 * mission stays unclaimable, and a force-start doesn't lift it (resume does).
 */
export function taskNotHeld(): SQL {
  return sql`(${tasks.context}->'heldBy') IS NULL`;
}

/**
 * Per-task check for /api/tasks/[id]/start: returns true when the task's mission
 * is held (and should be blocked), false otherwise. Mirrors the missionNotHeld()
 * SQL gate semantics — both live in this file to keep the implementations together.
 *
 * The call site is responsible for checking bypassHeldGate / forceOverride before
 * invoking this helper.
 */
export async function checkMissionHeld(missionId: string): Promise<boolean> {
  const mission = await db.query.missions.findFirst({
    where: and(eq(missions.id, missionId), eq(missions.isHeld, true)),
    columns: { id: true },
  });
  return !!mission;
}
