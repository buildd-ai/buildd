/** Query half of the staged self-review readout: treatment-arm workers' milestones. */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db/client';
import { experimentAssignments, workers } from './db/schema';
import { classifyStagedReview, stagedReviewRecordsFromMilestones, type StagedReviewReadout } from './staged-self-review';
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

export const STAGED_REVIEW_READOUT_ROW_LIMIT = 5000;

export function buildStagedReviewTasksQuery(experimentId: string, policyVersion: number) {
  return db
    .select({ taskId: experimentAssignments.taskId })
    .from(experimentAssignments)
    .where(and(
      eq(experimentAssignments.experimentId, experimentId),
      eq(experimentAssignments.policyVersion, policyVersion),
      eq(experimentAssignments.arm, 'treatment'),
    ))
    .limit(STAGED_REVIEW_READOUT_ROW_LIMIT);
}

export function buildStagedReviewWorkersQuery(taskIds: string[]) {
  return db.select({ taskId: workers.taskId, milestones: workers.milestones }).from(workers).where(inArray(workers.taskId, taskIds));
}

export async function runStagedSelfReviewReadout(
  experiment: { id: string; policyVersion: number },
  limits: { touchRate?: number; flipRate?: number } = {},
): Promise<StagedReviewReadout & { skipped: number }> {
  const rows = await buildStagedReviewTasksQuery(experiment.id, experiment.policyVersion);
  const taskIds = rows.map(r => r.taskId).filter((id): id is string => !!id);
  if (taskIds.length === 0) return { ...classifyStagedReview([], limits), skipped: 0 };
  const ws = await buildStagedReviewWorkersQuery(taskIds);
  const { records, skipped } = stagedReviewRecordsFromMilestones(ws);
  return { ...classifyStagedReview(records, limits), skipped };
}
