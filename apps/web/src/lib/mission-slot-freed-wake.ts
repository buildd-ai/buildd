/**
 * A worker on a mission task going terminal frees a slot against the
 * mission's `maxConcurrentTasks` cap (claim route, `mission_concurrent`).
 * A sibling the claim route deferred for exactly that reason has nothing
 * else to re-check it on a host-polled workspace: runners are push-driven
 * and their fallback poll is hourly (RUNNER_HEARTBEAT_INTERVAL_MS), and
 * `wakeOldestPendingTaskOnCapacityFreed` only fires for a cloud-dispatch
 * webhook workspace. So a deferred task sat pending with idle runners while
 * `explain` (correctly, by then) said "next in line, no gate" — a final
 * verification was stranded behind a criterion check that had long finished.
 *
 * Fires for any workspace, but only for a mission that has a cap: with no
 * cap there is no slot to free. A wake means "reconsider this task now",
 * never "assign it" (dispatch-authority.ts) — the claim route re-applies
 * every gate, the mission cap included.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missions, tasks } from '@buildd/core/db/schema';
import { claimablePendingWhere } from '@/app/api/cron/queue-stall/fleet-idle';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { wakeTask } from '@/lib/dispatch-authority';
import { sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';

export async function wakeMissionSlotWaiter(finishedTaskId: string | null): Promise<void> {
  if (!finishedTaskId) return;
  try {
    const finished = await db.query.tasks.findFirst({
      where: sqlWhere(eq(tasks.id, finishedTaskId)),
      columns: { missionId: true },
    });
    const missionId = finished?.missionId ?? null;
    if (!missionId) return;

    const mission = await db.query.missions.findFirst({
      where: sqlWhere(eq(missions.id, missionId)),
      columns: { maxConcurrentTasks: true },
    });
    if (mission?.maxConcurrentTasks == null) return;

    const candidate = await db.query.tasks.findFirst({
      where: sqlWhere(and(
        eq(tasks.missionId, missionId),
        claimablePendingWhere(new Date()),
        // A dependency-blocked sibling is not waiting on the slot; waking it
        // would spend the one wake on a claim the deps gate refuses.
        depsGate(),
        ne(tasks.id, finishedTaskId),
      )),
      orderBy: sqlOrderByFn((t, { desc, asc }) => [desc(t.priority), asc(t.createdAt)]),
      columns: { id: true },
    });
    if (!candidate) return;
    await wakeTask(candidate.id, 'capacity.freed');
  } catch (err) {
    console.error(`[mission-slot-freed] wake failed after task ${finishedTaskId}:`, err);
  }
}
