/**
 * DB reads behind the Insights flow. Split from `insights-flow.ts` so the fold
 * stays pure and client-safe. Every read is scoped to the given workspaces,
 * which the caller resolves from one team.
 */

import { db } from '@buildd/core/db';
import { workers, releases, releaseTasks, workspaces, missions } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import {
  bucketMsFor,
  buildFlowSeries,
  windowMsFor,
  type FlowReleaseRow,
  type FlowSeries,
  type FlowWindow,
  type FlowWorkerRow,
} from './insights-flow';

/** Cap on worker rows per request; newest first, so a cut drops the oldest work. */
export const FLOW_ROW_LIMIT = 5000;

/**
 * How far before the window to read finished workers: a PR opened before the
 * window can still be in review, merged or awaiting release inside it.
 */
const LOOKBACK_MS = 14 * 24 * 3_600_000;

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);

/** The team's workspace ids: the scope every flow read is limited to. */
export async function teamWorkspaceIds(teamId: string): Promise<string[]> {
  const rows = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.teamId, teamId));
  return (rows as { id: string }[]).map(r => r.id);
}

export async function fetchFlowWorkerRows(workspaceIds: string[], since: Date): Promise<FlowWorkerRow[]> {
  if (workspaceIds.length === 0) return [];
  const rows = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, workspaceIds),
      isNotNull(workers.startedAt),
      or(isNull(workers.completedAt), gte(workers.completedAt, since), gte(workers.mergedAt, since)),
    ),
    columns: {
      id: true,
      taskId: true,
      workspaceId: true,
      status: true,
      startedAt: true,
      completedAt: true,
      updatedAt: true,
      prNumber: true,
      mergedAt: true,
      prLifecycleStatus: true,
      prLastCheckedAt: true,
      supersededAt: true,
      abandonedAt: true,
      prBaseRef: true,
    },
    with: {
      task: {
        columns: { id: true, title: true, status: true, roleSlug: true, parentTaskId: true, missionId: true },
      },
    },
    orderBy: [desc(workers.startedAt), desc(workers.id)],
    limit: FLOW_ROW_LIMIT,
  });
  return (rows as any[]).map(w => ({
    workerId: w.id,
    taskId: w.taskId ?? null,
    parentTaskId: w.task?.parentTaskId ?? null,
    taskTitle: w.task?.title ?? null,
    taskStatus: w.task?.status ?? null,
    roleSlug: w.task?.roleSlug ?? null,
    missionId: w.task?.missionId ?? null,
    workspaceId: w.workspaceId,
    status: w.status,
    startedAt: ms(w.startedAt),
    completedAt: ms(w.completedAt),
    updatedAt: ms(w.updatedAt),
    prNumber: w.prNumber ?? null,
    mergedAt: ms(w.mergedAt),
    prLifecycleStatus: w.prLifecycleStatus ?? null,
    prLastCheckedAt: ms(w.prLastCheckedAt),
    prSupersededAt: ms(w.supersededAt),
    prAbandonedAt: ms(w.abandonedAt),
    prBaseRef: w.prBaseRef ?? null,
  }));
}

export async function fetchFlowReleases(workspaceIds: string[], since: Date): Promise<{
  releases: FlowReleaseRow[];
  releaseTasks: { releaseId: string; taskId: string }[];
  releaseWorkspaceIds: string[];
}> {
  if (workspaceIds.length === 0) return { releases: [], releaseTasks: [], releaseWorkspaceIds: [] };
  const [recent, everReleased] = await Promise.all([
    db.query.releases.findMany({
      where: and(inArray(releases.workspaceId, workspaceIds), gte(releases.createdAt, since)),
      columns: { id: true, workspaceId: true, version: true, state: true, healthyAt: true, deployedAt: true, dispatchedAt: true, createdAt: true },
    }),
    db.selectDistinct({ workspaceId: releases.workspaceId })
      .from(releases)
      .where(inArray(releases.workspaceId, workspaceIds)),
  ]);
  const releaseRows: FlowReleaseRow[] = (recent as any[]).map(r => ({
    id: r.id,
    workspaceId: r.workspaceId,
    version: r.version ?? null,
    state: r.state,
    at: (r.healthyAt ?? r.deployedAt ?? r.createdAt).getTime(),
    cutAt: (r.dispatchedAt ?? r.createdAt).getTime(),
  }));
  const ids = releaseRows.map(r => r.id);
  const edges = ids.length
    ? await db.select({ releaseId: releaseTasks.releaseId, taskId: releaseTasks.taskId })
        .from(releaseTasks)
        .where(inArray(releaseTasks.releaseId, ids))
    : [];
  return {
    releases: releaseRows,
    releaseTasks: edges as { releaseId: string; taskId: string }[],
    releaseWorkspaceIds: (everReleased as { workspaceId: string }[]).map(r => r.workspaceId),
  };
}

/**
 * When each mission's own PR (its `primaryPrNumber`) merged into trunk, for the
 * missions whose tasks merged into a mission branch. Missions with no merged
 * primary PR are absent: their work has not reached trunk.
 */
export async function fetchMissionTrunkMerges(missionIds: string[]): Promise<Record<string, number>> {
  if (missionIds.length === 0) return {};
  const rows = await db
    .select({ missionId: missions.id, mergedAt: workers.mergedAt })
    .from(missions)
    .innerJoin(workers, and(eq(workers.workspaceId, missions.workspaceId), eq(workers.prNumber, missions.primaryPrNumber)))
    .where(and(inArray(missions.id, missionIds), isNotNull(workers.mergedAt)));
  const out: Record<string, number> = {};
  for (const r of rows as { missionId: string; mergedAt: Date | null }[]) {
    const t = ms(r.mergedAt);
    if (t != null && (out[r.missionId] == null || t < out[r.missionId])) out[r.missionId] = t;
  }
  return out;
}

/** The flow series for a set of workspaces (one team's), for the given window. */
export async function loadFlowSeries(workspaceIds: string[], window: FlowWindow, now = Date.now()): Promise<FlowSeries & { truncated: boolean }> {
  const from = now - windowMsFor(window);
  const since = new Date(from - LOOKBACK_MS);
  const [workerRows, rel] = await Promise.all([
    fetchFlowWorkerRows(workspaceIds, since),
    fetchFlowReleases(workspaceIds, since),
  ]);
  const viaMission = new Set(
    workerRows.filter(w => w.missionId && w.mergedAt != null && (w.prBaseRef ?? '').startsWith('mission/')).map(w => w.missionId!),
  );
  const missionTrunkMergedAt = await fetchMissionTrunkMerges([...viaMission]);
  const series = buildFlowSeries({
    window: { from, to: now },
    bucketMs: bucketMsFor(window),
    now,
    workers: workerRows,
    ...rel,
    missionTrunkMergedAt,
  });
  return { ...series, truncated: workerRows.length >= FLOW_ROW_LIMIT };
}
