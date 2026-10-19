/**
 * The task page's mission context bar row (mission-context-bar.ts): the
 * mission, its schedule, its tasks' card columns and each task's newest
 * workers — the selection a Home card makes (lib/mission-card-views.ts).
 *
 * Read as plain column selects the page batches with its other first reads,
 * not as one nested relational query: the nested form repeats every column
 * name on every task and worker row, which for a large mission is most of
 * what crosses the wire (spec 3ef37387 R-5). The rows are assembled into the
 * same `MissionCardRow` the relational query returned.
 */
import { db } from '@buildd/core/db';
import { missions, taskSchedules, tasks, workers } from '@buildd/core/db/schema';
import { eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { MissionCardRow } from '@/lib/mission-card-view';
import type { MergePolicy } from '@buildd/shared';
import { MISSION_CARD_TASK_COLUMNS, MISSION_CARD_TASK_EXTRAS, MISSION_CARD_WORKERS_WITH, MISSION_CARD_WORKER_COLUMNS } from '@/lib/mission-card-views';

/** The mission columns the bar's builders read. */
export const MISSION_CONTEXT_COLUMNS = {
  id: true, title: true, status: true, orchestrationMode: true, dependsOnMissionId: true,
  dependencyMetAt: true, criteriaEscalatedAt: true, isHeld: true, armedAt: true, executor: true, startAt: true,
  goalCriteria: true, goalCriteriaState: true, completedAt: true, workingBranch: true,
  integrationBranchEnabled: true, mergePolicy: true, requiresReview: true,
} as const;

export const MISSION_CONTEXT_SCHEDULE_COLUMNS = {
  id: true, nextRunAt: true, lastRunAt: true, cronExpression: true, lastDeferralReason: true, lastDeferredAt: true, maxConcurrentFromSchedule: true,
} as const;

const pick = <T extends Record<string, unknown>>(table: T, spec: Record<string, true>) =>
  Object.fromEntries(Object.keys(spec).map(k => [k, table[k]])) as Record<string, T[keyof T]>;

/** The four statements: the mission (with its schedule), its tasks and their newest workers. */
export function missionContextReads(missionId: string) {
  const scheduleFields = Object.fromEntries(Object.keys(MISSION_CONTEXT_SCHEDULE_COLUMNS).map(k => [`schedule_${k}`, (taskSchedules as unknown as Record<string, SQL>)[k]]));
  const mission = db.select({ ...pick(missions as never, MISSION_CONTEXT_COLUMNS), ...scheduleFields })
    .from(missions).leftJoin(taskSchedules, eq(taskSchedules.id, missions.scheduleId))
    .where(eq(missions.id, missionId)).limit(1);
  const extras = Object.fromEntries(Object.entries(MISSION_CARD_TASK_EXTRAS).map(([k, f]) => [k, (f as (t: unknown, ops: unknown) => SQL)(tasks, { sql })]));
  const missionTasks = db.select({ ...pick(tasks as never, MISSION_CARD_TASK_COLUMNS), ...extras }).from(tasks).where(eq(tasks.missionId, missionId));
  // Each task's newest MISSION_CARD_WORKERS_WITH.limit workers, in the relation's order.
  const ranked = db.select({
    ...pick(workers as never, MISSION_CARD_WORKER_COLUMNS),
    taskId: workers.taskId,
    rn: sql<number>`row_number() over (partition by ${workers.taskId} order by ${workers.startedAt} desc, ${workers.updatedAt} desc)`.as('rn'),
  }).from(workers)
    .where(inArray(workers.taskId, db.select({ id: tasks.id }).from(tasks).where(eq(tasks.missionId, missionId))))
    .as('w');
  const workerFields = Object.fromEntries(Object.keys(MISSION_CARD_WORKER_COLUMNS).map(k => [k, (ranked as unknown as Record<string, SQL>)[k]]));
  const missionWorkers = db.select({ ...workerFields, taskId: ranked.taskId })
    .from(ranked).where(lte(ranked.rn, MISSION_CARD_WORKERS_WITH.limit))
    .orderBy(sql`${ranked.taskId}`, sql`${ranked.rn}`);
  return [mission, missionTasks, missionWorkers] as const;
}

/** The rows `missionContextReads` returned, as the `MissionCardRow` the bar builds from. Null when the mission is gone. */
export function missionContextRowOf(
  missionRows: ReadonlyArray<Record<string, unknown>>,
  taskRows: ReadonlyArray<Record<string, unknown>>,
  workerRows: ReadonlyArray<Record<string, unknown>>,
): (Omit<MissionCardRow, 'integrationBranchEnabled'> & { integrationBranchEnabled?: boolean; mergePolicy?: MergePolicy | null; requiresReview?: boolean }) | null {
  const m = missionRows[0];
  if (!m) return null;
  const mission: Record<string, unknown> = {};
  const schedule: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k.startsWith('schedule_')) schedule[k.slice('schedule_'.length)] = v;
    else mission[k] = v;
  }
  const byTask = new Map<string, Array<Record<string, unknown>>>();
  for (const { taskId, ...w } of workerRows) {
    const list = byTask.get(taskId as string) ?? [];
    list.push(w);
    byTask.set(taskId as string, list);
  }
  return {
    ...mission,
    schedule: schedule.id == null ? null : schedule,
    tasks: taskRows.map(t => ({ ...t, workers: byTask.get(t.id as string) ?? [] })),
  } as never;
}
