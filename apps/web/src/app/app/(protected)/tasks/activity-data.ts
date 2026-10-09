/**
 * Server loader for Activity's Now/History view. Reads the rows, projects
 * them through lib/activity-delivery.ts and returns plain data for the client.
 *
 * Mission groups are projected from the same rows and the same projection
 * inputs the Missions page uses (its `buildActiveMissionsQueryArgs` task and
 * worker shape: every fact `projectMissionDelivery` reads, workers newest
 * first, five per task), so a mission's chip, landed n/m and next milestone
 * are identical on Activity, Missions and Home.
 *
 * This file is core: the missions module's rules arrive as `rules`
 * (scripts/module-boundaries.test.ts), as they do for the projection.
 */
import { db } from '@buildd/core/db';
import { missions, tasks as tasksTable, workers } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, isNull, ne, notInArray } from 'drizzle-orm';
import { LIVE_WORKER_STATUSES, TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { projectMissionDelivery, type MissionDelivery, type MissionTaskRules } from '@/lib/delivery-projection';
import {
  buildActivityHistory, buildActivityNow, latestTask, reviewOf,
  type ActivityNow, type ActivityTaskInput, type Episode, type LatestTask,
} from '@/lib/activity-delivery';

export interface ActivityTaskRow {
  id: string;
  title: string;
  status: string;
  mode: string | null;
  taskClass: string | null;
  parentTaskId: string | null;
  missionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  result: unknown;
  context: unknown;
}

export interface ActivityData {
  now: ActivityNow;
  history: Episode[];
  latest: LatestTask | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Recent roots: the History window. Live work outside it is added by `loadLiveRootIds`. */
export const ACTIVITY_WINDOW_DAYS = 30;
export const ACTIVITY_ROOT_LIMIT = 200;
/** Open or agent-held roots, however old. Bounded so a backlog cannot stall the page. */
export const ACTIVITY_LIVE_ROOT_LIMIT = 500;
/** Attempts for the loaded roots, newest first: a cap drops the oldest retries, never the live one. */
export const ACTIVITY_CHILD_LIMIT = 2000;

/**
 * The root each live task belongs to: an open root, or the parent of an
 * attempt an agent is running. Deduplicated, first seen first.
 */
export function liveRootIdsOf(openRootIds: readonly string[], liveTasks: ReadonlyArray<{ id: string; parentTaskId: string | null }>): string[] {
  return [...new Set([...openRootIds, ...liveTasks.map(t => t.parentTaskId ?? t.id)])];
}

/**
 * Roots that belong in Now however long ago they were last touched: not
 * terminal, or with an agent live on them or on one of their attempts.
 * The recent window (newest `ACTIVITY_ROOT_LIMIT` in `ACTIVITY_WINDOW_DAYS`)
 * alone starves these on a busy workspace: a root's `updatedAt` does not move
 * while a repair attempt runs, so fresh completed work pushes it out.
 */
export async function loadLiveRootIds(workspaceIds: readonly string[]): Promise<string[]> {
  if (workspaceIds.length === 0) return [];
  const ws = [...workspaceIds];
  const [open, live] = await Promise.all([
    db.select({ id: tasksTable.id }).from(tasksTable)
      .where(and(inArray(tasksTable.workspaceId, ws), isNull(tasksTable.parentTaskId), notInArray(tasksTable.status, [...TERMINAL_TASK_STATUSES])))
      .orderBy(desc(tasksTable.updatedAt))
      .limit(ACTIVITY_LIVE_ROOT_LIMIT),
    db.select({ id: tasksTable.id, parentTaskId: tasksTable.parentTaskId }).from(workers)
      .innerJoin(tasksTable, eq(workers.taskId, tasksTable.id))
      .where(and(inArray(workers.workspaceId, ws), inArray(tasksTable.workspaceId, ws), inArray(workers.status, [...LIVE_WORKER_STATUSES])))
      .limit(ACTIVITY_LIVE_ROOT_LIMIT),
  ]);
  return liveRootIdsOf(open.map(r => r.id), live);
}

/**
 * The mission projection exactly as the Missions page builds it
 * (missions/page.tsx): same fields, same rules.
 */
export function missionDeliveryOf(obj: { id: string; title: string; status: string; isHeld?: boolean | null; integrationBranchEnabled?: boolean | null; tasks?: unknown[] }, rules: MissionTaskRules): MissionDelivery {
  return projectMissionDelivery({
    id: obj.id, title: obj.title, status: obj.status, href: `/app/missions/${obj.id}`,
    isHeld: obj.isHeld ?? false, integrationBranch: obj.integrationBranchEnabled === true,
    tasks: (obj.tasks ?? []) as never,
  }, rules);
}

export async function loadActivity(input: {
  tasks: readonly ActivityTaskRow[];
  missionTitles: ReadonlyMap<string, string>;
  /** Live task id → `<client> · local`, for work a local session is doing. */
  localClientByTaskId: ReadonlyMap<string, string>;
  now: number;
  /** `@buildd/core/mission-helpers`, passed by the page. */
  rules: MissionTaskRules;
}): Promise<ActivityData> {
  const { rules } = input;
  const ids = input.tasks.map(t => t.id);
  const missionIds = [...new Set(input.tasks.map(t => t.missionId).filter((x): x is string => !!x))];

  const [workerRows, missionRows] = await Promise.all([
    ids.length === 0 ? [] : db.query.workers.findMany({
      where: inArray(workers.taskId, ids),
      columns: {
        taskId: true, status: true, name: true, startedAt: true, completedAt: true, updatedAt: true,
        prUrl: true, prNumber: true, mergedAt: true, prLifecycleStatus: true, supersededByPrNumber: true,
        abandonedAt: true, lastCommitSha: true, waitingFor: true,
      },
      orderBy: [desc(workers.startedAt)],
    }),
    missionIds.length === 0 ? [] : db.query.missions.findMany({
      where: and(inArray(missions.id, missionIds), ne(missions.status, 'completed')),
      columns: { id: true, title: true, status: true, isHeld: true, integrationBranchEnabled: true },
      with: {
        tasks: {
          columns: { id: true, title: true, status: true, kind: true, mode: true, creationSource: true, category: true, parentTaskId: true, dependsOn: true, taskClass: true },
          with: {
            workers: {
              columns: { status: true, prUrl: true, mergedAt: true, prLifecycleStatus: true, supersededByPrNumber: true, abandonedAt: true },
              limit: 5,
              orderBy: (w: any, { desc: d }: any) => [d(w.startedAt), d(w.updatedAt)],
            },
          },
        },
      },
    }),
  ]);

  const byTask = new Map<string, typeof workerRows>();
  for (const w of workerRows) if (w.taskId) byTask.set(w.taskId, [...(byTask.get(w.taskId) ?? []), w]);

  const deliveries = (missionRows as any[]).map(m => missionDeliveryOf(m, rules));

  const tasks: ActivityTaskInput[] = input.tasks.map(t => {
    const ws = byTask.get(t.id) ?? [];
    const type = rules.deriveTaskType(t);
    const isReview = type === 'review' || type === 'review-retry';
    const waiting = ws.find(w => w.status === 'waiting_input')?.waitingFor;
    const local = input.localClientByTaskId.get(t.id);
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      mode: t.mode,
      taskClass: t.taskClass,
      parentTaskId: t.parentTaskId,
      missionId: t.missionId,
      missionTitle: t.missionId ? input.missionTitles.get(t.missionId) ?? null : null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      waitingPrompt: waiting ? waiting.prompt || 'Needs input' : null,
      review: isReview ? reviewOf(t.result, t.context) : null,
      workers: ws.map((w, i) => ({
        status: w.status,
        name: i === 0 && local ? local : w.name,
        startedAt: iso(w.startedAt),
        completedAt: iso(w.completedAt),
        updatedAt: iso(w.updatedAt),
        prUrl: w.prUrl,
        prNumber: w.prNumber,
        mergedAt: iso(w.mergedAt),
        prLifecycleStatus: w.prLifecycleStatus,
        supersededByPrNumber: w.supersededByPrNumber,
        abandonedAt: iso(w.abandonedAt),
        lastCommitSha: w.lastCommitSha,
      })),
    };
  });

  const args = { tasks, missions: deliveries, rules };
  return {
    now: buildActivityNow({ ...args, now: input.now }),
    history: buildActivityHistory(args),
    latest: latestTask(tasks, rules),
  };
}
