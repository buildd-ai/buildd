/**
 * The rows `computeMissionSummary` reads, for any number of missions, in a
 * fixed number of batched reads: the missions with their workspace's config
 * and schedule, their tasks; then together the tasks' workers (the newest few
 * per task and every PR-bearing one), the kernel's delivery displays and
 * views, out-of-mission dependencies, the claim gate's released edges, and an
 * exact live-worker count. The same reads `loadMissionStages` makes, plus the
 * columns the mission card reads, so one pass feeds both projections.
 *
 * The visual review state is read too, for the missions whose summary needs
 * it (`summaryReadsVisualReview`); it may consult GitHub through the surface
 * audit's file evidence, which is why it is read here and not by a page.
 *
 * A write path's read, not a page's: the store calls it after the response
 * (lib/mission-summary-store.ts). It is scoped by mission id only; whoever
 * reads the stored summary scopes that read to the caller.
 */
import { db } from '@buildd/core/db';
import { missions, tasks, workers } from '@buildd/core/db/schema';
import { sqlExtras, sqlWhere } from '@buildd/core/db/relational-sql';
import { and, inArray, sql } from 'drizzle-orm';
import { stageContextSql, stageWorkersPredicate } from './mission-stage-sql';
import { getOwnerDeliveryDisplays, getDeliveryViewsForTasks } from './workflow/delivery-view';
import { loadDependencyRows } from './dependency-rows';
import { foreignDependencyIds } from './mission-helpers';
import { loadMissionsReleasedEdges } from './mission-board-waiting';
import { MISSION_CARD_SCHEDULE_EXTRAS, MISSION_CARD_TASK_EXTRAS } from './mission-card-views';
import { LIVE_WORKER_STATUSES } from './task-presentation';
import { summaryReadsVisualReview } from './mission-card-visual-reviews';
import type { MissionVisualReviewState } from './workflow/visual-review-state';
import type { MissionSummaryInput } from './mission-summary';

/** Every mission's rows, keyed by mission id. A mission that does not exist is absent. */
export async function loadMissionSummaryInputs(
  missionIds: readonly string[],
  /** `visualReview: false`: leave the review out (a page deriving a missing summary must not reach GitHub). */
  opts: { visualReview?: boolean } = {},
): Promise<Map<string, MissionSummaryInput>> {
  const out = new Map<string, MissionSummaryInput>();
  const ids = [...new Set(missionIds)];
  if (ids.length === 0) return out;

  const [missionRows, taskRows] = await Promise.all([
    db.query.missions.findMany({
      where: sqlWhere(inArray(missions.id, ids)),
      columns: {
        id: true, title: true, status: true, workspaceId: true, isHeld: true, armedAt: true, executor: true,
        startAt: true, orchestrationMode: true, dependsOnMissionId: true, dependencyMetAt: true,
        criteriaEscalatedAt: true, goalCriteria: true, goalCriteriaState: true, completedAt: true,
        integrationBranchEnabled: true, workingBranch: true, mergePolicy: true, releasedAt: true,
        lastTaskStartedAt: true, createdAt: true, updatedAt: true, teamId: true, primaryPrNumber: true,
      },
      with: {
        workspace: { columns: { name: true, gitConfig: true, releaseConfig: true } },
        schedule: {
          columns: { id: true, nextRunAt: true, lastRunAt: true, cronExpression: true, lastDeferralReason: true, lastDeferredAt: true, maxConcurrentFromSchedule: true, totalRuns: true },
          extras: MISSION_CARD_SCHEDULE_EXTRAS,
        },
      },
    }),
    db.query.tasks.findMany({
      where: sqlWhere(inArray(tasks.missionId, ids)),
      columns: {
        id: true, missionId: true, title: true, label: true, status: true, taskClass: true, kind: true,
        mode: true, category: true, roleSlug: true, createdAt: true, updatedAt: true, parentTaskId: true,
        creationSource: true, dependsOn: true, missionPhaseIndex: true, missionPhaseLabel: true,
        outputRequirement: true, scheduleId: true, startAt: true, loopIteration: true,
        loopConfig: true, loopState: true,
      },
      // Never the whole context: the stage's projected keys, and the card's digest as `context`.
      extras: { ...sqlExtras({ stageContext: stageContextSql }), ...MISSION_CARD_TASK_EXTRAS },
    }),
  ]);
  if (missionRows.length === 0) return out;

  const taskIds = taskRows.map(t => t.id);
  const foreignIdsByMission = new Map<string, string[]>();
  for (const id of ids) {
    const own = taskRows.filter(t => t.missionId === id);
    if (own.length > 0) foreignIdsByMission.set(id, foreignDependencyIds(own as never));
  }
  const foreignIds = [...new Set([...foreignIdsByMission.values()].flat())];
  const workspaceIds = [...new Set(missionRows.map(m => m.workspaceId).filter((w): w is string => !!w))];
  const visualIds = opts.visualReview === false ? [] : missionRows
    .filter(m => summaryReadsVisualReview({ ...m, tasks: taskRows.filter(t => t.missionId === m.id) }))
    .map(m => m.id);
  const [workerRows, deliveries, deliveryViews, foreignDeps, releasedEdges, liveRows, visualReviews, verdicts] = await Promise.all([
    taskIds.length > 0
      ? db.select({
          id: workers.id, taskId: workers.taskId, status: workers.status,
          startedAt: workers.startedAt, createdAt: workers.createdAt, completedAt: workers.completedAt, updatedAt: workers.updatedAt,
          turns: workers.turns, exitCause: workers.exitCause,
          prUrl: workers.prUrl, prNumber: workers.prNumber, prBaseRef: workers.prBaseRef, mergedAt: workers.mergedAt, prLifecycleStatus: workers.prLifecycleStatus,
          supersededByPrNumber: workers.supersededByPrNumber, abandonedAt: workers.abandonedAt,
          // A worker parked on a question: the list strip draws it as waiting on you.
          waitingFor: workers.waitingFor,
        })
          .from(workers)
          .where(and(inArray(workers.taskId, taskIds), stageWorkersPredicate()))
      : [],
    getOwnerDeliveryDisplays(taskIds),
    getDeliveryViewsForTasks(taskIds).catch(() => new Map()),
    foreignIds.length > 0 ? loadDependencyRows(foreignIds).catch(() => new Map()) : new Map(),
    workspaceIds.length > 0 ? loadMissionsReleasedEdges(ids, workspaceIds) : new Map(),
    taskIds.length > 0
      ? db.select({ missionId: tasks.missionId, n: sql<number>`count(distinct ${workers.id})::int` })
          .from(workers)
          .innerJoin(tasks, sql`${workers.taskId} = ${tasks.id}`)
          .where(and(inArray(tasks.missionId, ids), inArray(workers.status, [...LIVE_WORKER_STATUSES])))
          .groupBy(tasks.missionId)
      : [],
    loadVisualReviews(visualIds),
    loadVerdicts(missionRows),
  ]);

  const live = new Map<string, number>();
  for (const r of liveRows as Array<{ missionId: string | null; n: number }>) if (r.missionId) live.set(r.missionId, Number(r.n) || 0);

  for (const m of missionRows) {
    const own = taskRows.filter(t => t.missionId === m.id);
    const ownIds = new Set(own.map(t => t.id));
    const pick = <V>(map: ReadonlyMap<string, V>) => new Map([...map].filter(([k]) => ownIds.has(k)));
    out.set(m.id, {
      missionRows: [m],
      taskRows: own as MissionSummaryInput['taskRows'],
      workerRows: (workerRows as Array<{ taskId: string | null }>).filter(w => w.taskId && ownIds.has(w.taskId)) as MissionSummaryInput['workerRows'],
      deliveries: pick(deliveries as ReadonlyMap<string, unknown>),
      deliveryViews: pick(deliveryViews as ReadonlyMap<string, unknown>),
      foreignIdsByMission: new Map(foreignIdsByMission.has(m.id) ? [[m.id, foreignIdsByMission.get(m.id)!]] : []),
      foreignDeps: foreignDeps as ReadonlyMap<string, unknown>,
      releasedEdges: new Map((releasedEdges as ReadonlyMap<string, unknown[]>).has(m.id) ? [[m.id, (releasedEdges as ReadonlyMap<string, unknown[]>).get(m.id)!]] : []),
      liveWorkers: live.get(m.id) ?? 0,
      ...(visualReviews.has(m.id) ? { visualReview: visualReviews.get(m.id) ?? null } : {}),
      escalationGateVerdict: verdicts.get(m.id) ?? null,
    });
  }
  return out;
}

/** Each mission's visual review state; one that could not be read is null (the card then reads no review). */
async function loadVisualReviews(ids: string[]): Promise<Map<string, MissionVisualReviewState | null>> {
  if (ids.length === 0) return new Map();
  const { getMissionVisualReviewState } = await import('./workflow/visual-review-state-load');
  return new Map(await Promise.all(ids.map(async id => [id, await getMissionVisualReviewState(id).catch(() => null)] as const)));
}

/**
 * The escalation gate's stored verdict on each mission's own PR (no model
 * call): whether a not-landed mission's next step is the owner's or Buildd's.
 */
async function loadVerdicts(rows: ReadonlyArray<{ id: string; teamId: string | null; workspaceId: string | null; primaryPrNumber: number | null }>): Promise<Map<string, MissionSummaryInput['escalationGateVerdict']>> {
  const out = new Map<string, MissionSummaryInput['escalationGateVerdict']>();
  const byTeam = new Map<string, Map<string, string>>();
  for (const m of rows) {
    if (!m.teamId || !m.workspaceId || m.primaryPrNumber == null) continue;
    const keys = byTeam.get(m.teamId) ?? new Map<string, string>();
    keys.set(`pr:${m.workspaceId}:${m.primaryPrNumber}`, m.id);
    byTeam.set(m.teamId, keys);
  }
  if (byTeam.size === 0) return out;
  const { loadMissionVerdicts } = await import('@buildd/core/mission-verdicts');
  await Promise.all([...byTeam].map(async ([teamId, keys]) => {
    for (const [key, verdict] of await loadMissionVerdicts(teamId, [...keys.keys()])) {
      const missionId = keys.get(key);
      if (missionId && verdict) out.set(missionId, verdict);
    }
  }));
  return out;
}
