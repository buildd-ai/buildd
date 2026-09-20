/**
 * The query half of the task-area readout: one select, and the mapping from
 * stored rows onto the analysis units in `./task-area-readout.ts`.
 *
 * Split for the same reason the memory-digest readout is: mocking `db` makes
 * every WHERE predicate unobservable, so the arithmetic is tested against
 * literal rows with no mock at all and the cohort filter is tested by rendering
 * it to SQL text.
 *
 * `policy_version` is the predicate that must never be missing. A version bump
 * redefines what an arm means AND re-randomises assignment, so pooling two
 * versions is not a noisier comparison — it is a meaningless one.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from './db/client';
import { taskAreaPredictionEvents } from './db/schema';
import { TASK_AREA_EXPERIMENT_ID } from './task-area-prediction';
import { computeTaskAreaReadout, type TaskAreaReadout, type TaskAreaRow } from './task-area-readout';

/** Upper bound on rows pulled into memory for one readout. */
export const READOUT_ROW_LIMIT = 5000;

/**
 * Cohort filter. Both predicates are load-bearing: `experiment_id` because the
 * salt includes it and a future experiment could reuse a version string, and
 * `policy_version` because arms drawn under different versions are not the
 * same arms.
 */
export function taskAreaCohortScope(policyVersion: string) {
  return and(
    eq(taskAreaPredictionEvents.experimentId, TASK_AREA_EXPERIMENT_ID),
    eq(taskAreaPredictionEvents.policyVersion, policyVersion),
  );
}

function asPaths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];
}

/** Fetch the cohort's rows. Workspace scoping is deliberately absent — the
 * comparison is about the predictor, not about one repo, and filtering here
 * would hide how much of the cohort a single workspace contributes. */
export async function fetchTaskAreaRows(policyVersion: string): Promise<TaskAreaRow[]> {
  const rows = await db
    .select()
    .from(taskAreaPredictionEvents)
    .where(taskAreaCohortScope(policyVersion))
    .orderBy(desc(taskAreaPredictionEvents.createdAt))
    .limit(READOUT_ROW_LIMIT);

  return rows.map(r => ({
    taskId: r.taskId,
    arm: r.arm,
    policyVersion: r.policyVersion,
    predictedPathSource: r.predictedPathSource,
    predictedPaths: asPaths(r.predictedPaths),
    regexPaths: asPaths(r.regexPaths),
    actualPaths: r.actualPaths === null ? null : asPaths(r.actualPaths),
    neighboursConsidered: r.neighboursConsidered,
    topScore: r.topScore === null ? null : Number(r.topScore),
  }));
}

/** Compute the readout for a policy version. */
export async function runTaskAreaReadout(policyVersion: string): Promise<TaskAreaReadout> {
  return computeTaskAreaReadout(await fetchTaskAreaRows(policyVersion), policyVersion);
}
