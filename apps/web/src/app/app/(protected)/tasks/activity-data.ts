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
import { missions, workers } from '@buildd/core/db/schema';
import { and, desc, inArray, ne } from 'drizzle-orm';
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
