/**
 * The missions behind Health › Runners' lanes, for the chart's caption: a
 * selected bar names its mission and how much of it has landed. Landed and
 * total come from the same delivery projection the Missions list reads, so
 * the two never disagree.
 */
import { db } from '@buildd/core/db';
import { missions, missionSummaries } from '@buildd/core/db/schema';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { MISSION_SUMMARY_VERSION, type FleetSnapshot } from '@buildd/shared';
import type { LaneMission } from '@/components/fleet/runner-lanes';
import { projectMissionDelivery, type MissionTaskRow } from '@/lib/delivery-projection';
import { MISSION_TASK_BASE_COLUMNS, MISSION_WORKER_BASE_COLUMNS } from '@/lib/missions-query';
import { sqlOrderByFn, sqlWhere } from '@buildd/core/db/relational-sql';

export function laneMissionIds(fleet: FleetSnapshot): string[] {
  const ids = new Set<string>();
  for (const r of [...fleet.runners, ...(fleet.sessions ? [fleet.sessions] : [])]) {
    for (const s of r.slots) for (const b of s.lane.bars) if (b.missionId) ids.add(b.missionId);
  }
  return [...ids];
}

export interface LaneMissionRow {
  id: string;
  title: string;
  status: string;
  isHeld?: boolean | null;
  armedAt?: Date | string | null;
  integrationBranchEnabled?: boolean | null;
  tasks: readonly MissionTaskRow[];
}

export function summarizeLaneMissions(rows: readonly LaneMissionRow[]): Record<string, LaneMission> {
  const out: Record<string, LaneMission> = {};
  for (const m of rows) {
    const d = projectMissionDelivery({
      id: m.id, title: m.title, status: m.status, href: `/app/missions/${m.id}`,
      isHeld: m.isHeld ?? false, armedAt: m.armedAt ?? null, integrationBranch: m.integrationBranchEnabled === true, tasks: m.tasks,
    }, missionHelpers);
    out[m.id] = { title: m.title, landed: d.landed, total: d.total };
  }
  return out;
}

/**
 * One query for every mission in the window; a failure leaves the caption on
 * the task. Landed and total come from the mission's stored summary (spec
 * 3ef37387 R-13: the delivery projection written when its work changes), so
 * the caption never loads a mission's tasks and workers. A mission with no
 * stored summary yet (one the reconcile has not reached) is read the old way,
 * from its tasks, alone.
 */
export async function loadLaneMissions(fleet: FleetSnapshot, teamId: string | null): Promise<Record<string, LaneMission>> {
  const ids = laneMissionIds(fleet);
  if (ids.length === 0) return {};
  const scope = teamId ? and(inArray(missions.id, ids), eq(missions.teamId, teamId)) : inArray(missions.id, ids);
  const stored = await db
    .select({
      id: missions.id,
      title: missions.title,
      landed: sql<number | null>`(${missionSummaries.summary}->'home'->'delivery'->>'landed')::int`,
      total: sql<number | null>`(${missionSummaries.summary}->'home'->'delivery'->>'total')::int`,
    })
    .from(missions)
    .leftJoin(missionSummaries, and(eq(missionSummaries.missionId, missions.id), eq(missionSummaries.version, MISSION_SUMMARY_VERSION)))
    .where(scope);
  const out: Record<string, LaneMission> = {};
  const missing: string[] = [];
  for (const m of stored) {
    if (m.landed == null || m.total == null) missing.push(m.id);
    else out[m.id] = { title: m.title, landed: m.landed, total: m.total };
  }
  if (missing.length === 0) return out;
  const rows = await db.query.missions.findMany({
    where: sqlWhere(inArray(missions.id, missing)),
    columns: { id: true, title: true, status: true, isHeld: true, armedAt: true, integrationBranchEnabled: true },
    with: {
      tasks: {
        columns: MISSION_TASK_BASE_COLUMNS,
        with: { workers: { columns: MISSION_WORKER_BASE_COLUMNS, limit: 5, orderBy: sqlOrderByFn((w, { desc }) => [desc(w.startedAt)]) } },
      },
    },
  });
  return { ...out, ...summarizeLaneMissions(rows as unknown as LaneMissionRow[]) };
}
