import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { BYPASS_MISSION_BUDGET_KEY } from '@/lib/bypass-flags';

/**
 * Context key set by /api/tasks/[id]/start when forceOverride=true and the
 * task's mission is `budget_exhausted`. The claim loop reads this flag to let a
 * single force-started task through while the mission stays exhausted.
 *
 * Re-exported from the bypass-flags contract rather than redeclared — the key
 * is evaluated in both SQL and TypeScript, so it must have exactly one
 * definition (docs/specs/mission-task-lifecycle.md, rule CG-4).
 */
export { BYPASS_MISSION_BUDGET_KEY };

/**
 * Mission cost-budget gate.
 *
 * Unlike the held gate there is no SQL prefilter counterpart: the claim route
 * evaluates `missions.status = 'budget_exhausted'` inside the dispatch loop
 * (mission gate #1), where the mission rows have already been batch-fetched.
 * This helper is the per-task check used by /api/tasks/[id]/start and by the
 * queue-stall watchdog, and it MUST agree with that loop check — see
 * `checkMissionHeld` in ./held-gate.ts for the same pairing rationale.
 *
 * Returns true when the task should be blocked.
 *
 * `budget_exhausted` is a one-way door: nothing clears it except a human
 * raising `costBudgetUsd` (see the auto-resume branch in api/missions/[id]),
 * and it gates every task in the mission simultaneously — the largest blast
 * radius of any claim gate, which is why it needs a visible state and an
 * override rather than a silent skip.
 *
 * The call site is responsible for checking bypassMissionBudget / forceOverride
 * before invoking this helper.
 */
export async function checkMissionBudgetExhausted(missionId: string): Promise<boolean> {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, status: true },
  });
  return mission?.status === 'budget_exhausted';
}
