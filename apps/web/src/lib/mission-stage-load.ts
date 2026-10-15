/**
 * Every listed mission's stage (`missionStage`) and progress cells
 * (`taskRowsProgress`, the mission page's Overview strip) in three batched
 * reads, one per table, whatever the number of missions: the missions with
 * their workspace's config, their tasks, and those tasks' workers. Each read
 * is scoped to the given missions AND the caller's workspaces, so a mission id
 * from another workspace yields nothing. The stage reads only the PR-bearing
 * workers; the progress cells read every one, as the strip does.
 */
import { db } from '@buildd/core/db';
import { missions, tasks, workers } from '@buildd/core/db/schema';
import type { WorkspaceGitConfig, WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { and, inArray } from 'drizzle-orm';
import { detectArchetype } from '@buildd/core/release-archetype';
import type { GoalCriteriaState, GoalCriterion, MissionStage } from '@buildd/shared';
import { resolvePolicy } from './merge-policy';
import type { MergeTier } from './mission-checks';
import { missionStage, type MissionStagePr, type MissionStageTask } from './mission-stage';
import { taskRowsProgress } from './mission-strip-order';

export async function loadMissionStages(missionIds: string[], workspaceIds: string[]): Promise<Map<string, MissionStage>> {
  const out = new Map<string, MissionStage>();
  if (missionIds.length === 0 || workspaceIds.length === 0) return out;

  const [missionRows, taskRows] = await Promise.all([
    db.query.missions.findMany({
      where: sqlWhere(and(inArray(missions.id, missionIds), inArray(missions.workspaceId, workspaceIds))),
      columns: {
        id: true, status: true, isHeld: true, integrationBranchEnabled: true, workingBranch: true,
        goalCriteria: true, goalCriteriaState: true, mergePolicy: true, releasedAt: true,
      },
      with: { workspace: { columns: { name: true, gitConfig: true, releaseConfig: true } } },
    }),
    db.query.tasks.findMany({
      where: sqlWhere(and(inArray(tasks.missionId, missionIds), inArray(tasks.workspaceId, workspaceIds))),
      columns: {
        id: true, missionId: true, title: true, status: true, taskClass: true, kind: true,
        mode: true, category: true, roleSlug: true, context: true, createdAt: true,
        // What the progress cells' board projection reads besides the above.
        updatedAt: true, label: true, parentTaskId: true, creationSource: true, dependsOn: true,
        missionPhaseIndex: true, missionPhaseLabel: true, outputRequirement: true,
      },
    }),
  ]);

  const taskIds = taskRows.map(t => t.id);
  // Only the columns the board's worker input reads: no milestones, no
  // current action, so the cells stay cheap for a list.
  const workerRows = taskIds.length > 0
    ? await db.select({
        id: workers.id, taskId: workers.taskId, status: workers.status,
        startedAt: workers.startedAt, createdAt: workers.createdAt, completedAt: workers.completedAt, updatedAt: workers.updatedAt,
        prUrl: workers.prUrl, prNumber: workers.prNumber, mergedAt: workers.mergedAt, prLifecycleStatus: workers.prLifecycleStatus,
        supersededByPrNumber: workers.supersededByPrNumber, abandonedAt: workers.abandonedAt,
      })
        .from(workers)
        .where(inArray(workers.taskId, taskIds))
    : [];

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
    rows.push({ ...(t as Record<string, unknown>), id: t.id, title: t.title ?? '', status: t.status, workers: ws });
    progressRows.set(t.missionId, rows);
    const list = tasksByMission.get(t.missionId) ?? [];
    list.push({
      id: t.id, title: t.title ?? null, status: t.status, taskClass: t.taskClass ?? null, kind: t.kind ?? null,
      mode: t.mode ?? null, category: t.category ?? null, roleSlug: t.roleSlug ?? null, context: t.context ?? null,
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
    out.set(m.id, { ...stage, progress: taskRowsProgress(progressRows.get(m.id) ?? []) });
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
