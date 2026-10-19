/**
 * Every listed mission's stage (`missionStage`) and progress cells
 * (`taskRowsProgress`, the mission page's Overview strip) in a fixed number of
 * batched reads, whatever the number of missions: the missions with their
 * workspace's config and their tasks; then, together, those tasks' workers,
 * their kernel delivery displays, the out-of-mission tasks they depend on, and
 * the claim gate's released edges. The missions, tasks and edges reads are
 * scoped to the given missions AND the caller's workspaces, so a mission id
 * from another workspace yields nothing; the rest read by the ids those
 * returned. The stage reads only the PR-bearing workers; the progress cells
 * get what the mission page gives its board (delivery displays, dependency
 * rows, released edges), so a closed unmerged delivery is never a done square.
 * The gate facts' waiting kinds are not loaded: they word why a waiting cell
 * waits and never move a cell's state or group.
 */
import { db } from '@buildd/core/db';
import { missions, tasks, workers } from '@buildd/core/db/schema';
import { sqlExtras, sqlWhere } from '@buildd/core/db/relational-sql';
import { and, inArray } from 'drizzle-orm';
import type { MissionStage } from '@buildd/shared';
import { stageContextSql, stageDependencyFailedSql, stageWorkersPredicate } from './mission-stage-sql';
import { getOwnerDeliveryDisplays, getDeliveryViewsForTasks } from './workflow/delivery-view';
import { loadDependencyRows } from './dependency-rows';
import { foreignDependencyIds } from './mission-helpers';
import { loadMissionsReleasedEdges } from './mission-board-waiting';
import { assembleMissionStages } from './mission-stage-assemble';

export async function loadMissionStages(missionIds: string[], workspaceIds: string[]): Promise<Map<string, MissionStage>> {
  const out = new Map<string, MissionStage>();
  if (missionIds.length === 0 || workspaceIds.length === 0) return out;

  const [missionRows, taskRows] = await Promise.all([
    db.query.missions.findMany({
      where: sqlWhere(and(inArray(missions.id, missionIds), inArray(missions.workspaceId, workspaceIds))),
      columns: {
        id: true, status: true, isHeld: true, armedAt: true, integrationBranchEnabled: true, workingBranch: true,
        goalCriteria: true, goalCriteriaState: true, mergePolicy: true, releasedAt: true,
      },
      with: { workspace: { columns: { name: true, gitConfig: true, releaseConfig: true } } },
    }),
    db.query.tasks.findMany({
      where: sqlWhere(and(inArray(tasks.missionId, missionIds), inArray(tasks.workspaceId, workspaceIds))),
      columns: {
        id: true, missionId: true, title: true, status: true, taskClass: true, kind: true,
        mode: true, category: true, roleSlug: true, createdAt: true,
        // What the progress cells' board projection reads besides the above.
        updatedAt: true, label: true, parentTaskId: true, creationSource: true, dependsOn: true,
        missionPhaseIndex: true, missionPhaseLabel: true, outputRequirement: true,
      },
      // Never the whole context: only the keys the stage reads (mission-stage-sql.ts).
      extras: sqlExtras({ stageContext: stageContextSql, stageDependencyFailed: stageDependencyFailedSql }),
    }),
  ]);

  const taskIds = taskRows.map(t => t.id);
  // Only the columns the board's worker input reads: no milestones, no
  // current action, so the cells stay cheap for a list.
  const foreignIdsByMission = new Map<string, string[]>();
  for (const id of missionIds) {
    const own = taskRows.filter(t => t.missionId === id);
    if (own.length > 0) foreignIdsByMission.set(id, foreignDependencyIds(own as never));
  }
  const foreignIds = [...new Set([...foreignIdsByMission.values()].flat())];
  const [rawWorkerRows, deliveries, deliveryViews, foreignDeps, releasedEdges] = await Promise.all([
    taskIds.length > 0
    ? db.select({
        id: workers.id, taskId: workers.taskId, status: workers.status,
        startedAt: workers.startedAt, createdAt: workers.createdAt, completedAt: workers.completedAt, updatedAt: workers.updatedAt,
        prUrl: workers.prUrl, prNumber: workers.prNumber, mergedAt: workers.mergedAt, prLifecycleStatus: workers.prLifecycleStatus,
        supersededByPrNumber: workers.supersededByPrNumber, abandonedAt: workers.abandonedAt,
      })
        .from(workers)
        // The newest few per task and every PR-bearing one (mission-stage-sql.ts).
        .where(and(inArray(workers.taskId, taskIds), stageWorkersPredicate()))
    : [],
    // The page's own loads, by the ids above: one query each, never throwing past the list.
    getOwnerDeliveryDisplays(taskIds),
    // §7: a kernel-owned delivery's merged/open/closed reading replaces its PR worker's columns.
    getDeliveryViewsForTasks(taskIds).catch(() => new Map()),
    foreignIds.length > 0 ? loadDependencyRows(foreignIds).catch(() => new Map()) : new Map(),
    loadMissionsReleasedEdges(missionIds, workspaceIds),
  ]);

  return assembleMissionStages({ missionRows, taskRows, workerRows: rawWorkerRows, deliveries, deliveryViews, foreignIdsByMission, foreignDeps, releasedEdges });
}
