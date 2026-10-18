import { db } from '@buildd/core/db';
import { taskSchedules, missions } from '@buildd/core/db/schema';
import { eq, and, lt, inArray, sql } from 'drizzle-orm';
import { isOverdue, estimateCronIntervalMs } from '@/lib/heartbeat-helpers';
import { notifyOperator } from '@/lib/pushover';
import { sqlExtras, sqlWhere } from '@buildd/core/db/relational-sql';

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
    // Heartbeats only, picked in SQL, and only the columns the check reads
    // (spec "Fast at any size", R-25): the template is KBs and a stalled
    // fleet can leave many schedules past due.
    const heartbeat = sql<unknown>`${taskSchedules.taskTemplate}->'context'->'heartbeat'`;
    const stuckSchedules = (await db.query.taskSchedules.findMany({
      where: sqlWhere(and(
        eq(taskSchedules.enabled, true),
        lt(taskSchedules.nextRunAt, now),
        sql`${heartbeat} = 'true'::jsonb`,
      )),
      columns: { id: true, cronExpression: true, nextRunAt: true, lastOverdueAlertAt: true },
      extras: sqlExtras({ heartbeat }),
    })) as Array<{ id: string; cronExpression: string; nextRunAt: Date | null; lastOverdueAlertAt: Date | null; heartbeat: unknown }>;

    const due = stuckSchedules.filter(schedule => {
      if (schedule.heartbeat !== true) return false;
      if (!schedule.nextRunAt) return false;
      if (!isOverdue(schedule.nextRunAt, schedule.cronExpression)) return false;
      const intervalMs = estimateCronIntervalMs(schedule.cronExpression);
      return !(
        schedule.lastOverdueAlertAt &&
        now.getTime() - new Date(schedule.lastOverdueAlertAt).getTime() < intervalMs
      );
    });
    if (due.length === 0) return 0;

    // One read for every linked mission, not one per schedule.
    const linked = await db.query.missions.findMany({
      where: sqlWhere(inArray(missions.scheduleId, due.map(s => s.id))),
      columns: { id: true, scheduleId: true },
    });
    const missionBySchedule = new Map<string, string>();
    for (const m of linked) if (m.scheduleId && !missionBySchedule.has(m.scheduleId)) missionBySchedule.set(m.scheduleId, m.id);

    for (const schedule of due) {
      const missionId = missionBySchedule.get(schedule.id);
      const subject = missionId ? `mission ${missionId}` : `schedule ${schedule.id}`;
      const overdueMin = Math.round((now.getTime() - new Date(schedule.nextRunAt!).getTime()) / 60_000);

      notifyOperator({
        app: 'alerts',
        title: `Check-in overdue: ${subject}`,
        message: `Mission check-in is ${overdueMin}m overdue. The cron may have stalled.`,
        priority: 0,
      });
      overdueHeartbeatAlerts++;
    }

    await db
      .update(taskSchedules)
      .set({ lastOverdueAlertAt: now, updatedAt: now })
      .where(inArray(taskSchedules.id, due.map(s => s.id)));
  } catch (overdueErr) {
    console.warn('[Cron] Overdue heartbeat check failed:', overdueErr instanceof Error ? overdueErr.message : overdueErr);
  }
  return overdueHeartbeatAlerts;
}
