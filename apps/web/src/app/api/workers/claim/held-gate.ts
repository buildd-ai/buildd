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
 * Local-executor gate for the claim route: TRUE when the task's mission is not
 * run from a person's local session (missions.executor = 'local').
 *
 *   - No missionId → claimable.
 *   - mission.executor = 'runner' (the default) → claimable.
 *   - mission.executor = 'local' → NOT claimable by runners.
 *
 * The route omits this gate for a verified interactive session's explicit
 * `claim_task {taskId}` — that is how the local session takes the task and gets
 * a normal tracked worker — and for an admin force claim. The dashboard's
 * force-start writes context.bypassHeldGate, which lifts this gate too: a
 * person who pressed "Start with override" asked a runner to take it.
 *
 * Orthogonal to missionNotHeld(): a held mission stays unclaimable by everyone,
 * interactive sessions included (held is the pause and wins over the executor).
 * Two-valued for the explicit-claim probe, like missionNotHeld().
 */
export function missionNotLocal(): SQL {
  return sql`(
    ${tasks.missionId} IS NULL
    OR ${bypassFlagCondition(tasks.context, BYPASS_HELD_GATE_KEY)}
    OR NOT EXISTS (
      SELECT 1 FROM ${missions} m
      WHERE m.id = ${tasks.missionId}
      AND m.executor = 'local'
    )
  )`;
}

/**
 * Per-task check for /api/tasks/[id]/start and the queue-stall watchdog: true
 * when the task's mission runs in a local session. The caller checks the
 * bypass flag / forceOverride first, as with checkMissionHeld().
 */
export async function checkMissionLocal(missionId: string): Promise<boolean> {
  const mission = await db.query.missions.findFirst({
    where: and(eq(missions.id, missionId), eq(missions.executor, 'local')),
    columns: { id: true },
  });
  return !!mission;
}

/**
 * Per-task variant of `checkMissionLocal`, for the claim route's role gate:
 * true when `taskId` belongs to a mission with executor='local'. Two queries
 * (task → missionId, then the already-tested mission check) rather than a
 * join, so a task with no mission short-circuits to false without a new SQL
 * shape to test.
 */
export async function checkTaskMissionLocal(taskId: string): Promise<boolean> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { missionId: true },
  });
  if (!task?.missionId) return false;
  return checkMissionLocal(task.missionId);
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
