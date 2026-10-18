/**
 * Each mission's stage and progress cells from rows already read: the pure
 * half of `loadMissionStages` (lib/mission-stage-load.ts), split out so the
 * stored mission summary (lib/mission-summary.ts) runs the same derivation
 * on the same rows without importing the database (spec 3ef37387 R-24).
 */
import type { WorkspaceGitConfig, WorkspaceReleaseConfig } from '@buildd/core/db/schema';
import { detectArchetype } from '@buildd/core/release-archetype';
import type { GoalCriteriaState, GoalCriterion, MissionStage } from '@buildd/shared';
import { resolvePolicy } from './merge-policy';
import type { MergeTier } from './mission-checks';
import { missionStage, type MissionStagePr, type MissionStageTask } from './mission-stage';
import { taskRowsProgress } from './mission-strip-order';
import { overlayDeliveryLifecycle } from './delivery-overlay';
import type { BoardExternalDepInput, ReleasedEdge } from './mission-board';

/** What `assembleMissionStages` reads: the loader's batched rows, or one mission's slice of them. */
export interface MissionStageRows {
  missionRows: ReadonlyArray<Record<string, any> & { id: string }>;
  taskRows: ReadonlyArray<Record<string, any> & { id: string; missionId: string | null }>;
  /** The tasks' workers as read, before the kernel's delivery reading is laid over them. */
  workerRows: ReadonlyArray<Record<string, any> & { taskId: string | null }>;
  deliveries: ReadonlyMap<string, unknown>;
  deliveryViews: ReadonlyMap<string, unknown>;
  foreignIdsByMission: ReadonlyMap<string, string[]>;
  foreignDeps: ReadonlyMap<string, unknown>;
  releasedEdges: ReadonlyMap<string, unknown[]>;
}

/** Each mission's stage and progress cells, from the rows `MissionStageRows` names. */
export function assembleMissionStages(rows: MissionStageRows): Map<string, MissionStage> {
  const { missionRows, taskRows, deliveries, foreignIdsByMission, foreignDeps, releasedEdges } = rows;
  const out = new Map<string, MissionStage>();
  const taskIds = taskRows.map(t => t.id);
  const rawWorkerRows = rows.workerRows as any[];
  const deliveryViews = rows.deliveryViews as Map<string, any>;
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
        gateFacts: { releasedEdges: (releasedEdges.get(m.id) ?? []) as ReleasedEdge[], waitingKinds: {} },
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
