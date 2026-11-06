/**
 * Staged self-review assignment: the write half. At claim time the server
 * records the arm the runner will draw for a task, so the readout
 * (./staged-self-review-readout-source.ts) reads treatment tasks from
 * experiment_assignments. Pure row logic lives in ./staged-draw.ts.
 */
import { and, eq } from 'drizzle-orm';
import { db } from './db/client';
import { experiments, experimentAssignments } from './db/schema';
import { stagedAssignmentRow, STAGED_SELF_REVIEW_FEATURE } from './staged-draw';

/**
 * Persist the staged draw. Only for a running staged_self_review experiment of
 * the same team, and only when the workspace's policy version matches the
 * experiment row (the readout filters on the row's version, so a mismatch
 * would be silently excluded: skip and warn instead). Idempotent on
 * (experiment_id, task_id). Never throws.
 */
export async function recordStagedReviewAssignment(args: {
  teamId: string | null | undefined;
  taskId: string;
  gitConfig: { selfReview?: unknown; selfReviewExperiment?: any } | null | undefined;
}): Promise<void> {
  try {
    const row = stagedAssignmentRow(args.taskId, args.gitConfig);
    if (!row || !args.teamId) return;
    const [exp] = await db
      .select({ id: experiments.id, kind: experiments.kind, status: experiments.status, policyVersion: experiments.policyVersion })
      .from(experiments)
      .where(and(eq(experiments.id, row.experimentId), eq(experiments.teamId, args.teamId)))
      .limit(1);
    if (!exp || exp.kind !== STAGED_SELF_REVIEW_FEATURE || exp.status !== 'running') return;
    if (exp.policyVersion !== row.policyVersion) {
      console.warn(`[staged-self-review] workspace policyVersion ${row.policyVersion} != experiment ${exp.policyVersion}; assignment for task ${args.taskId} not recorded`);
      return;
    }
    await db.insert(experimentAssignments).values({
      experimentId: row.experimentId,
      taskId: row.taskId,
      unitType: row.unitType,
      unitId: row.unitId,
      arm: row.arm,
      propensity: row.propensity,
      policyVersion: row.policyVersion,
      served: row.served,
      eligibility: { feature: STAGED_SELF_REVIEW_FEATURE },
    }).onConflictDoNothing({ target: [experimentAssignments.experimentId, experimentAssignments.taskId] });
  } catch (err) {
    console.warn(`[staged-self-review] failed to record assignment for task ${args.taskId}:`, err);
  }
}
