/**
 * Every listed mission's stage (`missionStage`) in three batched reads, one
 * per table, whatever the number of missions: the missions with their
 * workspace's config, their tasks, and those tasks' PR-bearing workers. Each
 * read is scoped to the given missions AND the caller's workspaces, so a
 * mission id from another workspace yields nothing.
 */
import { db } from '@buildd/core/db';
import { missions, tasks, workers } from '@buildd/core/db/schema';
import type { WorkspaceGitConfig, WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { and, inArray, isNotNull } from 'drizzle-orm';
import { detectArchetype } from '@buildd/core/release-archetype';
import type { GoalCriteriaState, GoalCriterion, MissionStage } from '@buildd/shared';
import { resolvePolicy } from './merge-policy';
import type { MergeTier } from './mission-checks';
import { missionStage, type MissionStagePr, type MissionStageTask } from './mission-stage';

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
      },
    }),
  ]);

  const taskIds = taskRows.map(t => t.id);
  const prRows = taskIds.length > 0
    ? await db.select({
        taskId: workers.taskId, prUrl: workers.prUrl, prNumber: workers.prNumber,
        mergedAt: workers.mergedAt, prLifecycleStatus: workers.prLifecycleStatus,
      })
        .from(workers)
        .where(and(inArray(workers.taskId, taskIds), isNotNull(workers.prUrl)))
    : [];

  const prsByTask = new Map<string, MissionStagePr[]>();
  for (const p of prRows) {
    if (!p.taskId) continue;
    const list = prsByTask.get(p.taskId) ?? [];
    list.push({ prUrl: p.prUrl ?? null, prNumber: p.prNumber ?? null, mergedAt: p.mergedAt ?? null, prLifecycleStatus: (p.prLifecycleStatus as string | null) ?? null });
    prsByTask.set(p.taskId, list);
  }
  const tasksByMission = new Map<string, MissionStageTask[]>();
  for (const t of taskRows) {
    if (!t.missionId) continue;
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
    out.set(m.id, missionStage({
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
    }));
  }
  return out;
}
