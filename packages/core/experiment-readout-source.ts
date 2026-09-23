/**
 * Experiment readout — the query half. Four narrow selects, joined in memory
 * by `assembleReadoutRows` (./experiment-readout.ts).
 *
 * Why four selects instead of one join: a task has several workers and
 * several attempt children, so a single join fans out and every aggregate has
 * to be de-duplicated in SQL. Four flat reads keyed by task id keep each
 * predicate trivially renderable — and each is rendered to SQL text in
 * __tests__/experiment-readout-source.test.ts, because a mocked `db` would
 * accept any predicate at all.
 *
 * `policy_version` is part of the cohort filter and must stay there: the
 * randomiser salts with it, so rows drawn under two versions are two different
 * experiments and pooling them is meaningless.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from './db/client';
import { experimentAssignments, taskOutcomes, tasks, workers } from './db/schema';
import {
  assembleReadoutRows,
  computeExperimentReadout,
  type AssignmentJoinRow,
  type ExperimentReadout,
  type ReadoutRow,
} from './experiment-readout';

/** Upper bound on assignment rows pulled into memory for one readout. */
export const EXPERIMENT_READOUT_ROW_LIMIT = 5000;

export function assignmentCohortScope(experimentId: string, policyVersion: number) {
  return and(
    eq(experimentAssignments.experimentId, experimentId),
    eq(experimentAssignments.policyVersion, policyVersion),
  );
}

export function buildAssignmentsQuery(experimentId: string, policyVersion: number) {
  return db
    .select({
      taskId: experimentAssignments.taskId,
      arm: experimentAssignments.arm,
      served: experimentAssignments.served,
      unitType: experimentAssignments.unitType,
      unitId: experimentAssignments.unitId,
      eligibility: experimentAssignments.eligibility,
      kind: tasks.kind,
      taskStatus: tasks.status,
    })
    .from(experimentAssignments)
    .innerJoin(tasks, eq(tasks.id, experimentAssignments.taskId))
    .where(assignmentCohortScope(experimentId, policyVersion))
    .orderBy(desc(experimentAssignments.assignedAt))
    .limit(EXPERIMENT_READOUT_ROW_LIMIT);
}

export function buildWorkersQuery(taskIds: string[]) {
  return db
    .select({
      taskId: workers.taskId,
      prUrl: workers.prUrl,
      mergedAt: workers.mergedAt,
      prLifecycleStatus: workers.prLifecycleStatus,
      turns: workers.turns,
      resultMeta: workers.resultMeta,
      createdAt: workers.createdAt,
    })
    .from(workers)
    .where(inArray(workers.taskId, taskIds));
}

export function buildAttemptChildrenQuery(taskIds: string[]) {
  return db
    .select({
      parentTaskId: tasks.parentTaskId,
      ciRetryPrNumber: tasks.ciRetryPrNumber,
      reviewerRetryPrNumber: tasks.reviewerRetryPrNumber,
    })
    .from(tasks)
    .where(and(inArray(tasks.parentTaskId, taskIds), eq(tasks.taskClass, 'attempt')));
}

export function buildOutcomesQuery(taskIds: string[]) {
  return db
    .select({
      taskId: taskOutcomes.taskId,
      exitCause: taskOutcomes.exitCause,
      createdAt: taskOutcomes.createdAt,
    })
    .from(taskOutcomes)
    .where(inArray(taskOutcomes.taskId, taskIds));
}

export async function fetchExperimentReadoutRows(experimentId: string, policyVersion: number): Promise<ReadoutRow[]> {
  const assignments = (await buildAssignmentsQuery(experimentId, policyVersion)) as AssignmentJoinRow[];
  if (assignments.length === 0) return [];
  const ids = assignments.map(a => a.taskId);
  const [ws, kids, outs] = await Promise.all([
    buildWorkersQuery(ids),
    buildAttemptChildrenQuery(ids),
    buildOutcomesQuery(ids),
  ]);
  return assembleReadoutRows(assignments, ws, kids, outs);
}

export async function runExperimentReadout(
  experiment: { id: string; policyVersion: number },
  opts: { minSamplePerArm: number },
): Promise<ExperimentReadout> {
  return computeExperimentReadout(await fetchExperimentReadoutRows(experiment.id, experiment.policyVersion), opts);
}
