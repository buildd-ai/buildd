/**
 * The reads behind the claim loop's coordination gates, shared by the claim
 * route and the start probe (`lib/coordination-probe.ts`) so both evaluate
 * `./coordination-gates` against the same rows.
 */
import { db } from '@buildd/core/db';
import { tasks, workers, missions } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, not } from 'drizzle-orm';
import { declaresNoScope } from '@buildd/core/path-overlap';
import { isExpiredParkedHolder } from '@buildd/core/path-claim-ttl';
import { isDispatchedReview } from '@/lib/read-only-review';
import { producesNoFileEdits, type OpenPrTask } from './coordination-gates';
import type { MissionInFlightRow } from './claim-plan-input';

/**
 * Tasks with an open PR per workspace (path-overlap layer 1). Closed PRs and
 * holders parked on a question past the TTL never block. Per worker on
 * purpose, unlike layer 2 (per task): this layer is keyed on the PR, and the
 * PR belongs to the one worker that opened it.
 */
export async function loadOpenPrTasksByWorkspace(workspaceIds: string[]): Promise<Map<string, OpenPrTask[]>> {
  const byWorkspace = new Map<string, OpenPrTask[]>();
  if (workspaceIds.length === 0) return byWorkspace;
  const openPrWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, workspaceIds),
      not(isNull(workers.prUrl)),
      isNull(workers.mergedAt),
      inArray(workers.status, ['running', 'idle', 'starting', 'waiting_input', 'completed']),
    ),
    columns: { workspaceId: true, taskId: true, prNumber: true, prUrl: true, branch: true, prBaseRef: true, prLifecycleStatus: true, status: true, updatedAt: true },
  });
  const activeOpenPrWorkers = openPrWorkers.filter(w => w.prLifecycleStatus !== 'closed' && !isExpiredParkedHolder(w));
  if (activeOpenPrWorkers.length === 0) return byWorkspace;
  const prTaskIds = activeOpenPrWorkers.map(w => w.taskId).filter(Boolean) as string[];
  const prTasks = prTaskIds.length > 0
    ? (await db.query.tasks.findMany({
        where: inArray(tasks.id, prTaskIds),
        columns: { id: true, pathManifest: true },
      })) ?? []
    : [];
  const manifestByTask = new Map(prTasks.map(t => [t.id, t.pathManifest as string[] | null]));
  for (const w of activeOpenPrWorkers) {
    const entry: OpenPrTask = {
      taskId: w.taskId,
      pathManifest: w.taskId ? (manifestByTask.get(w.taskId) ?? null) : null,
      prNumber: w.prNumber,
      prUrl: w.prUrl,
      workerStatus: (w.status as string | null) ?? null,
      prLifecycle: (w.prLifecycleStatus as string | null) ?? null,
      branch: w.branch ?? null,
      prBaseRef: w.prBaseRef ?? null,
    };
    const list = byWorkspace.get(w.workspaceId) ?? [];
    list.push(entry);
    byWorkspace.set(w.workspaceId, list);
  }
  return byWorkspace;
}

export type MissionClaimData = {
  id: string;
  status: string;
  maxConcurrentTasks: number | null;
  pacingMode: 'eager' | 'paced';
  pacingMaxPerHour: number | null;
  lastTaskStartedAt: Date | null;
  workingBranch: string | null;
  integrationBranchEnabled: boolean | null;
};

export interface MissionCoordinationData {
  missionClaimMap: Map<string, MissionClaimData>;
  /** missionId → in-flight NON-review tasks (reviews never occupy a mission slot). */
  missionActiveCountMap: Map<string, number>;
  /** missionId → its in-flight tasks that declared no file scope (`declaresNoScope`). */
  missionAdvisoryInFlight: Map<string, Set<string>>;
  missionInFlightRows: MissionInFlightRow[];
}

/**
 * Mission rows plus their in-flight tasks: ONE row-level query feeds the
 * concurrency count and the advisory-manifest serialization guard. Reviews
 * and non-file-editing tasks are excluded from the guard on both sides.
 */
export async function loadMissionCoordination(missionIds: string[]): Promise<MissionCoordinationData> {
  const out: MissionCoordinationData = {
    missionClaimMap: new Map(),
    missionActiveCountMap: new Map(),
    missionAdvisoryInFlight: new Map(),
    missionInFlightRows: [],
  };
  if (missionIds.length === 0) return out;
  const missionRows = await db.query.missions.findMany({
    where: inArray(missions.id, missionIds),
    columns: {
      id: true, status: true, maxConcurrentTasks: true, pacingMode: true,
      pacingMaxPerHour: true, lastTaskStartedAt: true,
      workingBranch: true, integrationBranchEnabled: true,
    },
  });
  for (const m of missionRows) out.missionClaimMap.set(m.id, m as MissionClaimData);

  out.missionInFlightRows = await db
    .select({ missionId: tasks.missionId, taskId: tasks.id, pathManifest: tasks.pathManifest, category: tasks.category, context: tasks.context, outputRequirement: tasks.outputRequirement })
    .from(workers)
    .innerJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(
      inArray(tasks.missionId, missionIds),
      inArray(workers.status, ['running', 'starting', 'idle', 'waiting_input']),
    ));
  for (const row of out.missionInFlightRows) {
    if (!row.missionId) continue;
    if (!isDispatchedReview(row.category, row.context)) {
      out.missionActiveCountMap.set(row.missionId, (out.missionActiveCountMap.get(row.missionId) ?? 0) + 1);
    }
    if (row.category !== 'review' && !producesNoFileEdits(row.outputRequirement)
      && declaresNoScope(row.pathManifest as string[] | null)) {
      const set = out.missionAdvisoryInFlight.get(row.missionId) ?? new Set<string>();
      if (row.taskId) set.add(row.taskId);
      out.missionAdvisoryInFlight.set(row.missionId, set);
    }
  }
  return out;
}
