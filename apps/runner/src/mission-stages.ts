/**
 * `mission.stage` on the runner's task list (spec c7410e76 R-18).
 *
 * The server's GET /api/tasks carries each task's mission (id, title, counts)
 * but not its stage: the stage is the missions module's projection, served by
 * GET /api/missions/stages so core never imports it. The runner's local
 * /api/tasks asks for the stages of exactly the missions its list holds and
 * puts each on its tasks' `mission`, so `buildd top` reads one shape.
 *
 * Best effort: any failure returns the list unchanged, without `stage`, and
 * top shows done/total only.
 */
import type { MissionStage } from '@buildd/shared';

interface TaskWithMission {
  missionId?: string | null;
  mission?: { id?: string } | null;
}

/** The distinct mission ids a task list holds, in first-seen order. */
export function listedMissionIds(tasks: readonly TaskWithMission[]): string[] {
  const ids = new Set<string>();
  for (const t of tasks) {
    const id = t.missionId ?? t.mission?.id;
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Each task whose mission has a stage gains `mission.stage`; every other row is returned as it was. */
export function attachMissionStages<T extends TaskWithMission>(tasks: T[], stages: Record<string, MissionStage>): T[] {
  return tasks.map(t => {
    const id = t.missionId ?? t.mission?.id;
    const stage = id ? stages[id] : undefined;
    return stage && t.mission && typeof t.mission === 'object' ? { ...t, mission: { ...t.mission, stage } } : t;
  });
}

export async function withMissionStages<T extends TaskWithMission>(
  tasks: T[],
  load: (missionIds: string[]) => Promise<Record<string, MissionStage>>,
): Promise<T[]> {
  const ids = listedMissionIds(tasks);
  if (ids.length === 0) return tasks;
  try {
    return attachMissionStages(tasks, await load(ids));
  } catch (err) {
    console.error('[tasks] mission stages failed:', err instanceof Error ? err.message : err);
    return tasks;
  }
}
