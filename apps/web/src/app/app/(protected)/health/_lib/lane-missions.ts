/**
 * The missions behind Health › Runners' lanes, for the chart's caption: a
 * selected bar names its mission and how much of it has landed. Landed and
 * total come from the same delivery projection the Missions list reads, so
 * the two never disagree.
 */
import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { and, eq, inArray } from 'drizzle-orm';
import type { FleetSnapshot } from '@buildd/shared';
import type { LaneMission } from '@/components/fleet/runner-lanes';
import { projectMissionDelivery, type MissionTaskRow } from '@/lib/delivery-projection';
import { MISSION_TASK_BASE_COLUMNS, MISSION_WORKER_BASE_COLUMNS } from '@/lib/missions-query';

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
  integrationBranchEnabled?: boolean | null;
  tasks: readonly MissionTaskRow[];
}

export function summarizeLaneMissions(rows: readonly LaneMissionRow[]): Record<string, LaneMission> {
  const out: Record<string, LaneMission> = {};
  for (const m of rows) {
    const d = projectMissionDelivery({
      id: m.id, title: m.title, status: m.status, href: `/app/missions/${m.id}`,
      isHeld: m.isHeld ?? false, integrationBranch: m.integrationBranchEnabled === true, tasks: m.tasks,
    }, missionHelpers);
    out[m.id] = { title: m.title, landed: d.landed, total: d.total };
  }
  return out;
}

/** One query for every mission in the window; a failure leaves the caption on the task. */
export async function loadLaneMissions(fleet: FleetSnapshot, teamId: string | null): Promise<Record<string, LaneMission>> {
  const ids = laneMissionIds(fleet);
  if (ids.length === 0) return {};
  const rows = await db.query.missions.findMany({
    where: teamId ? and(inArray(missions.id, ids), eq(missions.teamId, teamId)) : inArray(missions.id, ids),
    columns: { id: true, title: true, status: true, isHeld: true, integrationBranchEnabled: true },
    with: {
      tasks: {
        columns: MISSION_TASK_BASE_COLUMNS,
        with: { workers: { columns: MISSION_WORKER_BASE_COLUMNS, limit: 5, orderBy: (w, { desc }) => [desc(w.startedAt)] } },
      },
    },
  });
  return summarizeLaneMissions(rows as unknown as LaneMissionRow[]);
}
