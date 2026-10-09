/**
 * Who a task is for. Personal credentials and personal roles serve only this
 * person, so every claim-time decision about them asks here.
 *
 * Order: the task's own `createdByUserId`; then, walking up its parent tasks
 * (a retry or fix task names the task it repairs), the first one that has it;
 * then the creator of the mission it belongs to; then the creator of the
 * schedule that spawned it. `null` = no person — team credentials only.
 *
 * Only the main create path writes `createdByUserId`; the other ~30 places that
 * file tasks (retries, sweeps, webhooks) rely on this walk instead.
 */
import { eq } from 'drizzle-orm';
import { db } from './db';
import { missions, taskSchedules, tasks } from './db/schema';

export interface RequesterTaskFields {
  createdByUserId?: string | null;
  parentTaskId?: string | null;
  missionId?: string | null;
  scheduleId?: string | null;
}

/** How many parents to climb before giving up; retry chains are short. */
const MAX_PARENT_HOPS = 8;

export async function resolveTaskRequesterUserId(task: RequesterTaskFields): Promise<string | null> {
  if (task.createdByUserId) return task.createdByUserId;

  let current: RequesterTaskFields = task;
  const seen = new Set<string>();
  for (let hop = 0; hop < MAX_PARENT_HOPS && current.parentTaskId && !seen.has(current.parentTaskId); hop++) {
    seen.add(current.parentTaskId);
    const parent = await db.query.tasks.findFirst({
      where: eq(tasks.id, current.parentTaskId),
      columns: { createdByUserId: true, parentTaskId: true, missionId: true, scheduleId: true },
    });
    if (!parent) break;
    if (parent.createdByUserId) return parent.createdByUserId;
    current = {
      parentTaskId: parent.parentTaskId,
      missionId: current.missionId ?? parent.missionId,
      scheduleId: current.scheduleId ?? parent.scheduleId,
    };
  }

  const missionId = task.missionId ?? current.missionId;
  if (missionId) {
    const mission = await db.query.missions.findFirst({
      where: eq(missions.id, missionId),
      columns: { createdByUserId: true },
    });
    if (mission?.createdByUserId) return mission.createdByUserId;
  }

  const scheduleId = task.scheduleId ?? current.scheduleId;
  if (scheduleId) {
    const schedule = await db.query.taskSchedules.findFirst({
      where: eq(taskSchedules.id, scheduleId),
      columns: { createdByUserId: true },
    });
    if (schedule?.createdByUserId) return schedule.createdByUserId;
  }

  return null;
}

const requesterMemo = new WeakMap<object, Promise<string | null>>();

/**
 * `resolveTaskRequesterUserId`, memoized on the task object: the claim route
 * hands the same row to several role lookups, and the walk should run once.
 * Errors resolve to null (team roles only) rather than failing a claim.
 */
export function requesterOf(task: RequesterTaskFields & object): Promise<string | null> {
  let p = requesterMemo.get(task);
  if (!p) {
    p = resolveTaskRequesterUserId(task).catch(() => null);
    requesterMemo.set(task, p);
  }
  return p;
}
