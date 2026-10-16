import { db } from '@buildd/core/db';
import { taskEstimates } from '@buildd/core/db/schema';
import { taskEstimatesEnabled } from '@buildd/core/task-estimate-source';
import { desc, inArray } from 'drizzle-orm';

export type EstimateRow = { taskId: string; p50Minutes: number; p80Minutes: number };

/**
 * The frozen estimates the mission Overview's build estimate reads (spec
 * f7f67f1a R-23): the same rows the Plan page reads, and only for a team that
 * has the task-estimates switch on, the same gate the Plan page applies. A team
 * that turned estimates off after some were recorded sees no estimate here
 * either. Rows come newest first, so the first row per task is its estimate.
 */
export async function loadBuildEstimateRows(
  input: { teamId: string | null | undefined; taskIds: readonly string[]; finished: boolean },
  deps: { enabled?: (teamId: string) => Promise<boolean>; read?: (taskIds: string[]) => Promise<EstimateRow[]> } = {},
): Promise<EstimateRow[]> {
  if (input.finished || input.taskIds.length === 0 || !input.teamId) return [];
  const enabled = deps.enabled ?? taskEstimatesEnabled;
  if (!(await enabled(input.teamId))) return [];
  const read = deps.read ?? ((ids: string[]) => db
    .select({ taskId: taskEstimates.taskId, p50Minutes: taskEstimates.p50Minutes, p80Minutes: taskEstimates.p80Minutes })
    .from(taskEstimates)
    .where(inArray(taskEstimates.taskId, ids))
    .orderBy(desc(taskEstimates.createdAt)));
  return read([...input.taskIds]);
}
