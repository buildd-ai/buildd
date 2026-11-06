/**
 * Staged self-review readout: the query half. Reads the stage records the
 * runner stored as worker milestones for the experiment's treatment-arm tasks
 * and classifies them with classifyStagedReview (./staged-self-review.ts).
 * Both GET /readout (stagedReview) and GET /staged-readout call this one function.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db/client';
import { experimentAssignments, workers } from './db/schema';
import {
  classifyStagedReview,
  stagedReviewLabel,
  stagedReviewRecordsFromWorkers,
  type StagedReviewLabel,
  type StagedReviewReadout,
} from './staged-self-review';

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
  return db.select({ taskId: workers.taskId, milestones: workers.milestones, resultMeta: workers.resultMeta }).from(workers).where(inArray(workers.taskId, taskIds));
}

export async function runStagedSelfReviewReadout(
  experiment: { id: string; policyVersion: number },
  limits: { touchRate?: number; flipRate?: number } = {},
): Promise<StagedReviewReadout & { skipped: number; label: StagedReviewLabel }> {
  const rows = await buildStagedReviewTasksQuery(experiment.id, experiment.policyVersion);
  const taskIds = rows.map(r => r.taskId).filter((id): id is string => !!id);
  const ws = taskIds.length === 0 ? [] : await buildStagedReviewWorkersQuery(taskIds);
  const { records, skipped } = stagedReviewRecordsFromWorkers(ws);
  const readout = classifyStagedReview(records, limits);
  return { ...readout, skipped, label: stagedReviewLabel(readout) };
}
