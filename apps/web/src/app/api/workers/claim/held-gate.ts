import { sql, type SQL } from 'drizzle-orm';
import { tasks, missions } from '@buildd/core/db/schema';

/**
 * Context key set by /api/tasks/[id]/start when forceOverride=true and the task
 * has a missionId. The claim route reads this flag to bypass the held gate for
 * a single force-started task even when its parent mission is held.
 */
export const BYPASS_HELD_GATE_KEY = 'bypassHeldGate' as const;

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
  return sql`(
    ${tasks.missionId} IS NULL
    OR ${tasks.context}->>'bypassHeldGate' = 'true'
    OR NOT EXISTS (
      SELECT 1 FROM ${missions} m
      WHERE m.id = ${tasks.missionId}
      AND m.is_held = true
    )
  )`;
}
