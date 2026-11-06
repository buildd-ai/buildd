/** Query half of the staged self-review readout: treatment-arm workers' milestones. */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db/client';
import { experimentAssignments, workers } from './db/schema';
import { computeStagedReadout } from './staged-self-review-readout';
import { EXPERIMENT_READOUT_ROW_LIMIT, assignmentCohortScope } from './experiment-readout-source';

export async function runStagedReviewReadout(
  experiment: { id: string; policyVersion: number },
  limits: { touchRate?: number; flipRate?: number } = {},
) {
  const rows = await db
    .select({ taskId: experimentAssignments.taskId })
    .from(experimentAssignments)
    .where(and(assignmentCohortScope(experiment.id, experiment.policyVersion), eq(experimentAssignments.arm, 'treatment')))
    .limit(EXPERIMENT_READOUT_ROW_LIMIT);
  const ids = rows.map(r => r.taskId).filter((x): x is string => !!x);
  if (ids.length === 0) return computeStagedReadout([], limits);
  const ws = await db.select({ taskId: workers.taskId, milestones: workers.milestones }).from(workers).where(inArray(workers.taskId, ids));
  return computeStagedReadout(ws as any, limits);
}
