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
import type { WorkspaceGitConfig, WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { sqlExtras, sqlWhere } from '@buildd/core/db/relational-sql';
import { and, inArray } from 'drizzle-orm';
import { detectArchetype } from '@buildd/core/release-archetype';
import type { GoalCriteriaState, GoalCriterion, MissionStage } from '@buildd/shared';
import { resolvePolicy } from './merge-policy';
import type { MergeTier } from './mission-checks';
import { missionStage, type MissionStagePr, type MissionStageTask } from './mission-stage';
import { stageContextSql, stageWorkersPredicate } from './mission-stage-sql';
import { taskRowsProgress } from './mission-strip-order';
import { getOwnerDeliveryDisplays, getDeliveryViewsForTasks } from './workflow/delivery-view';
import { overlayDeliveryLifecycle } from './delivery-overlay';
import { loadDependencyRows } from './dependency-rows';
import { foreignDependencyIds } from './mission-helpers';
import { loadMissionsReleasedEdges } from './mission-board-waiting';
import type { BoardExternalDepInput } from './mission-board';

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
      extras: sqlExtras({ stageContext: stageContextSql }),
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

  const overlaid = overlayDeliveryLifecycle(taskIds.map(id => ({ id, workers: rawWorkerRows.filter(w => w.taskId === id) })), deliveryViews);
  const workerRows = overlaid.flatMap(t => t.workers);

  const prsByTask = new Map<string, MissionStagePr[]>();
  const workersByTask = new Map<string, Array<Record<string, unknown>>>();
  for (const w of workerRows) {
    if (!w.taskId) continue;
    const all = workersByTask.get(w.taskId) ?? [];
    all.push(w as Record<string, unknown>);
    workersByTask.set(w.taskId, all);
  }
  for (const p of workerRows) {
    if (!p.taskId || !p.prUrl) continue;
    const list = prsByTask.get(p.taskId) ?? [];
    list.push({ prUrl: p.prUrl ?? null, prNumber: p.prNumber ?? null, mergedAt: p.mergedAt ?? null, prLifecycleStatus: (p.prLifecycleStatus as string | null) ?? null });
    prsByTask.set(p.taskId, list);
  }
  const tasksByMission = new Map<string, MissionStageTask[]>();
  const progressRows = new Map<string, Parameters<typeof taskRowsProgress>[0][number][]>();
  for (const t of taskRows) {
    if (!t.missionId) continue;
    const rows = progressRows.get(t.missionId) ?? [];
    // Newest first, as the mission page's query orders them (`startedAt DESC`, never-started first).
    const ws = (workersByTask.get(t.id) ?? []).slice().sort((a, b) => { const x = startedMs(a), y = startedMs(b); return x === y ? 0 : x > y ? -1 : 1; });
    rows.push({ ...(t as Record<string, unknown>), id: t.id, title: t.title ?? '', status: t.status, workers: ws, delivery: deliveries.get(t.id) ?? null });
    progressRows.set(t.missionId, rows);
    const list = tasksByMission.get(t.missionId) ?? [];
    list.push({
      id: t.id, title: t.title ?? null, status: t.status, taskClass: t.taskClass ?? null, kind: t.kind ?? null,
      mode: t.mode ?? null, category: t.category ?? null, roleSlug: t.roleSlug ?? null, context: (t as { stageContext?: unknown }).stageContext ?? null,
      createdAt: (t as { createdAt?: string | Date | null }).createdAt ?? null,
      prs: prsByTask.get(t.id) ?? [],
    });
    tasksByMission.set(t.missionId, list);
  }

  for (const m of missionRows) {
    const ws = (m as { workspace?: { name: string; gitConfig: WorkspaceGitConfig | null; releaseConfig: WorkspaceReleaseConfig | null } | null }).workspace ?? null;
    const gitConfig = ws?.gitConfig ?? null;
    const trunk = (gitConfig as { defaultBranch?: unknown } | null)?.defaultBranch;
    const policy = resolvePolicy({ gitConfig }, {
      mergePolicy: (m.mergePolicy as never) ?? null,
      workingBranch: m.workingBranch ?? null,
      integrationBranchEnabled: m.integrationBranchEnabled === true,
    });
    const stage = missionStage({
      mission: {
        status: m.status,
        isHeld: m.isHeld === true,
        integrationBranchEnabled: m.integrationBranchEnabled === true,
        workingBranch: m.workingBranch ?? null,
        goalCriteria: (m.goalCriteria as GoalCriterion[] | null) ?? null,
        goalCriteriaState: (m.goalCriteriaState as GoalCriteriaState | null) ?? null,
        releasedAt: m.releasedAt ?? null,
      },
      tasks: tasksByMission.get(m.id) ?? [],
      target: typeof trunk === 'string' && trunk ? trunk : null,
      mergeTier: policy.tier as MergeTier,
      releaseConfigured: ws ? detectArchetype({ name: ws.name, releaseConfig: ws.releaseConfig, gitConfig }) !== 'none' : false,
    });
    const externalDeps = (foreignIdsByMission.get(m.id) ?? []).flatMap(id => (foreignDeps.has(id) ? [foreignDeps.get(id) as BoardExternalDepInput] : []));
    out.set(m.id, {
      ...stage,
      progress: taskRowsProgress(progressRows.get(m.id) ?? [], {
        externalDeps,
        gateFacts: { releasedEdges: releasedEdges.get(m.id) ?? [], waitingKinds: {} },
      }),
    });
  }
  return out;
}

/** A worker's start for newest-first order; a never-started worker sorts first, as NULLs do under DESC. */
function startedMs(w: Record<string, unknown>): number {
  const v = w.startedAt;
  if (v == null) return Number.POSITIVE_INFINITY;
  const ms = new Date(v as string | Date).getTime();
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}
