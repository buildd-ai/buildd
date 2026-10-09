/**
 * Loads what the Missions Plan page draws: the team's open missions with their
 * tasks' frozen estimates, each workspace's release config and recent
 * releases. `missionPlanInputs` is the pure half (rows in, planner input out)
 * so the mapping is tested without a database; the planner is lib/mission-plan.ts.
 */
import { db } from '@buildd/core/db';
import { releases, taskEstimates } from '@buildd/core/db/schema';
import { and, desc, gte, inArray, type SQL } from 'drizzle-orm';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { projectMissionDelivery, type DeliveryKind } from './delivery-projection';
import { buildActiveMissionsQueryArgs } from './missions-query';
import { projectReleaseCuts, type PlanMissionInput, type PlanBlock, type ReleasePlan } from './mission-plan';

const RELEASE_LOOKBACK_MS = 90 * 24 * 60 * 60_000;

/** Delivery kinds that wait on a person: the same two the Missions list files under "Needs you". */
const WAITING_ON_YOU: ReadonlySet<DeliveryKind> = new Set(['needs', 'notlanded']);

export interface PlanMissionRow {
  id: string;
  title: string;
  workspaceId: string | null;
  dependsOnMissionId: string | null;
  isHeld: boolean;
  tasks: Array<{
    id: string; status: string; dependsOn: string[] | null; updatedAt: Date | string | null;
    workers?: Array<{ startedAt: Date | string | null; completedAt: Date | string | null }>;
  }>;
}

const time = (v: Date | string | null | undefined) => (v ? new Date(v).getTime() : null);

/** Whether a mission waits on a person: the escalation-gate verdict (via the delivery kind) or a hold. */
export function planBlock(kind: DeliveryKind, isHeld: boolean): PlanBlock {
  if (WAITING_ON_YOU.has(kind)) return 'you';
  return isHeld || kind === 'held' ? 'held' : null;
}

export function missionPlanInputs(
  rows: readonly PlanMissionRow[],
  estimates: ReadonlyMap<string, { p50Minutes: number; p80Minutes: number }>,
  kinds: ReadonlyMap<string, DeliveryKind>,
): PlanMissionInput[] {
  return rows.map(m => ({
    id: m.id,
    title: m.title,
    href: `/app/missions/${m.id}`,
    workspaceId: m.workspaceId,
    blocked: planBlock(kinds.get(m.id) ?? 'planning', m.isHeld),
    dependsOnMissionId: m.dependsOnMissionId,
    tasks: m.tasks.map(t => {
      const started = (t.workers ?? []).map(w => time(w.startedAt)).filter((v): v is number => v != null);
      const ended = (t.workers ?? []).map(w => time(w.completedAt)).filter((v): v is number => v != null);
      const est = estimates.get(t.id);
      return {
        id: t.id,
        status: t.status,
        dependsOn: t.dependsOn ?? [],
        startedAt: started.length ? Math.min(...started) : null,
        endedAt: t.status === 'completed' ? (ended.length ? Math.max(...ended) : time(t.updatedAt)) : null,
        p50Minutes: est?.p50Minutes ?? null,
        p80Minutes: est?.p80Minutes ?? null,
      };
    }),
  }));
}

export interface LoadedMissionPlan {
  inputs: PlanMissionInput[];
  plans: Map<string, ReleasePlan>;
}

export async function loadMissionPlan(missionsWhere: SQL | undefined, now: number): Promise<LoadedMissionPlan> {
  const found = (await db.query.missions.findMany(buildActiveMissionsQueryArgs(missionsWhere) as any)) as any[];

  const taskIds = found.flatMap(m => (m.tasks ?? []).map((t: { id: string }) => t.id));
  const workspaceIds = [...new Set(found.map(m => m.workspaceId).filter((v): v is string => !!v))];

  const [estimateRows, releaseRows] = await Promise.all([
    taskIds.length === 0 ? [] : db
      .select({ taskId: taskEstimates.taskId, p50Minutes: taskEstimates.p50Minutes, p80Minutes: taskEstimates.p80Minutes })
      .from(taskEstimates)
      .where(inArray(taskEstimates.taskId, taskIds))
      .orderBy(desc(taskEstimates.createdAt)),
    workspaceIds.length === 0 ? [] : db
      .select({ workspaceId: releases.workspaceId, version: releases.version, createdAt: releases.createdAt })
      .from(releases)
      .where(and(inArray(releases.workspaceId, workspaceIds), gte(releases.createdAt, new Date(now - RELEASE_LOOKBACK_MS))))
      .orderBy(desc(releases.createdAt)),
  ]);

  // Newest estimate per task: rows arrive newest first.
  const estimates = new Map<string, { p50Minutes: number; p80Minutes: number }>();
  for (const e of estimateRows) if (!estimates.has(e.taskId)) estimates.set(e.taskId, e);

  const kinds = new Map<string, DeliveryKind>();
  for (const m of found) {
    kinds.set(m.id, projectMissionDelivery({
      id: m.id, title: m.title, status: m.status, href: `/app/missions/${m.id}`,
      isHeld: m.isHeld ?? false, integrationBranch: m.integrationBranchEnabled === true,
      tasks: m.tasks ?? [],
    }, missionHelpers).kind);
  }

  const plans = new Map<string, ReleasePlan>();
  for (const m of found) {
    if (!m.workspaceId || plans.has(m.workspaceId)) continue;
    const mine = releaseRows.filter(r => r.workspaceId === m.workspaceId);
    plans.set(m.workspaceId, projectReleaseCuts({
      config: (m.workspace as { releaseConfig?: Parameters<typeof projectReleaseCuts>[0]['config'] } | null)?.releaseConfig ?? null,
      releaseTimes: mine.map(r => r.createdAt.getTime()),
      latestVersion: mine.find(r => r.version)?.version ?? null,
      now,
    }));
  }

  return { inputs: missionPlanInputs(found as PlanMissionRow[], estimates, kinds), plans };
}

