import { db } from '@buildd/core/db';
import { taskSchedules, missions } from '@buildd/core/db/schema';
import { eq, and, lt } from 'drizzle-orm';
import { isOverdue, estimateCronIntervalMs } from '@/lib/heartbeat-helpers';
import { notify } from '@/lib/pushover';

/**
 * Check for heartbeat missions whose nextRunAt is still far in the past
 * (>2x their interval) — meaning the cron hasn't fired them recently.
 * Alert the owner so they know monitoring has stalled.
 *
 * Best-effort: every failure is swallowed (logged only) so the cron tick still
 * returns 200.
 *
 * Returns the number of overdue alerts sent this tick.
 */
export async function runOverdueHeartbeatAlerts(now: Date): Promise<number> {
  let overdueHeartbeatAlerts = 0;
  try {
    const stuckSchedules = await db.query.taskSchedules.findMany({
      where: and(
        eq(taskSchedules.enabled, true),
        lt(taskSchedules.nextRunAt, now),
      ),
    });

    for (const schedule of stuckSchedules) {
      const ctx = schedule.taskTemplate?.context as Record<string, unknown> | undefined;
      if (ctx?.heartbeat !== true) continue;
      if (!schedule.nextRunAt) continue;
      if (!isOverdue(schedule.nextRunAt, schedule.cronExpression)) continue;

      const intervalMs = estimateCronIntervalMs(schedule.cronExpression);
      if (
        schedule.lastOverdueAlertAt &&
        now.getTime() - new Date(schedule.lastOverdueAlertAt).getTime() < intervalMs
      ) continue;

      const linkedMission = await db.query.missions.findFirst({
        where: eq(missions.scheduleId, schedule.id),
        columns: { id: true, title: true },
      });

      const missionTitle = linkedMission?.title ?? schedule.name;
      const overdueMin = Math.round((now.getTime() - new Date(schedule.nextRunAt).getTime()) / 60_000);

      notify({
        app: 'alerts',
        title: `Heartbeat overdue: ${missionTitle}`,
        message: `Mission heartbeat is ${overdueMin}m overdue — monitoring may have stalled`,
        priority: 0,
      });

      await db
        .update(taskSchedules)
        .set({ lastOverdueAlertAt: now, updatedAt: now })
        .where(eq(taskSchedules.id, schedule.id));

      overdueHeartbeatAlerts++;
    }
  } catch (overdueErr) {
    console.warn('[Cron] Overdue heartbeat check failed:', overdueErr instanceof Error ? overdueErr.message : overdueErr);
  }
  return overdueHeartbeatAlerts;
}
