import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { experiments, experimentAssignments } from '@buildd/core/db/schema';
import { assignStagedReviewArm, effectiveStagedArm } from '@buildd/core/staged-self-review';

/**
 * Staged self-review (Living Spec f3742450): hand the runner the team's running
 * experiment so it can draw an arm per task and record propensity. The runner
 * reads `gitConfig.selfReviewExperiment`; nothing else supplies it.
 *
 * Only a workspace whose own `gitConfig.selfReview` is `acting` or `recording`
 * is touched; off stays untouched (no lookup, no footprint). A lookup failure
 * never fails a claim: the runner then draws control and no stage appears.
 */
export interface StagedExperimentRow {
  id: string;
  policyVersion: number;
  treatmentFraction: number;
  startedAt?: Date | null;
  config?: Record<string, unknown> | null;
}

/** Mirrors STAGED_SELF_REVIEW_FEATURE (packages/core/staged-self-review.ts); the test pins equality. Not imported: that file sits in the reviews module. */
export const STAGED_EXPERIMENT_KIND = 'staged_self_review';

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; row: StagedExperimentRow | null }>();

export function invalidateStagedExperimentCache(teamId?: string): void {
  if (teamId) cache.delete(teamId); else cache.clear();
}

export async function loadRunningStagedExperiment(teamId: string): Promise<StagedExperimentRow | null> {
  const hit = cache.get(teamId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;
  const rows = await db
    .select({
      id: experiments.id,
      policyVersion: experiments.policyVersion,
      treatmentFraction: experiments.treatmentFraction,
      startedAt: experiments.startedAt,
      config: experiments.config,
    })
    .from(experiments)
    .where(and(eq(experiments.teamId, teamId), eq(experiments.status, 'running'), eq(experiments.kind, STAGED_EXPERIMENT_KIND)));
  rows.sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
  const row = rows[0] ?? null;
  cache.set(teamId, { at: Date.now(), row });
  return row;
}

/** Pure: the workspace with the experiment attached, or the same object when nothing applies. */
export function withStagedExperiment<W extends { gitConfig?: any } | null | undefined>(
  workspace: W,
  experiment: StagedExperimentRow | null,
): W {
  const gc = workspace?.gitConfig;
  if (!workspace || !experiment) return workspace;
  if (gc?.selfReview !== 'acting' && gc?.selfReview !== 'recording') return workspace;
  const checklistVersion = (experiment.config as { checklistVersion?: unknown } | null | undefined)?.checklistVersion;
  return {
    ...workspace,
    gitConfig: {
      ...gc,
      selfReviewExperiment: {
        id: experiment.id,
        policyVersion: experiment.policyVersion,
        treatmentFraction: experiment.treatmentFraction,
        ...(typeof checklistVersion === 'string' ? { checklistVersion } : {}),
      },
    },
  };
}

/** Claim-time entry point: never throws. */
export async function attachStagedExperiment<W extends { gitConfig?: any; teamId?: string | null } | null | undefined>(
  workspace: W,
): Promise<W> {
  try {
    const sr = workspace?.gitConfig?.selfReview;
    if (!workspace?.teamId || (sr !== 'acting' && sr !== 'recording')) return workspace;
    return withStagedExperiment(workspace, await loadRunningStagedExperiment(workspace.teamId));
  } catch (err) {
    console.warn('[claim] staged self-review experiment not attached:', err instanceof Error ? err.message : err);
    return workspace;
  }
}

/**
 * Pure: the assignment row for one acting task, or null. It repeats the
 * runner's deterministic draw (same experiment, version, fraction, task id), so
 * the stored arm is the arm the runner serves. Recording and off workspaces
 * serve no stage and write nothing.
 */
export function buildStagedAssignment(
  workspace: { gitConfig?: any } | null | undefined,
  taskId: string,
): typeof experimentAssignments.$inferInsert | null {
  const gc = workspace?.gitConfig;
  const exp = gc?.selfReviewExperiment;
  if (gc?.selfReview !== 'acting' || !exp?.id || !taskId) return null;
  try {
    const drawn = assignStagedReviewArm({ taskId, experiment: { id: String(exp.id), policyVersion: exp.policyVersion ?? 1, treatmentFraction: exp.treatmentFraction } });
    const arm = effectiveStagedArm({ mode: 'acting', arm: drawn.arm });
    return {
      experimentId: String(exp.id),
      taskId,
      unitType: 'task',
      unitId: taskId,
      arm,
      propensity: drawn.propensity,
      policyVersion: Number(exp.policyVersion ?? 1),
      served: arm === 'treatment',
      eligibility: { kind: STAGED_EXPERIMENT_KIND, mode: 'acting' },
    };
  } catch {
    return null;
  }
}

/** Idempotent on (experiment, task); never throws. */
export async function recordStagedAssignment(workspace: { gitConfig?: any } | null | undefined, taskId: string): Promise<void> {
  const row = buildStagedAssignment(workspace, taskId);
  if (!row) return;
  try {
    await db.insert(experimentAssignments).values(row)
      .onConflictDoNothing({ target: [experimentAssignments.experimentId, experimentAssignments.taskId] });
  } catch (err) {
    console.warn(`[claim] staged assignment not recorded for task ${taskId}:`, err instanceof Error ? err.message : err);
  }
}
