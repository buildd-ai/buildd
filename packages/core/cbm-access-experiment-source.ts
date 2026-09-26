/**
 * CBM-access experiment — the stores half, called from the claim route after
 * the claim lock and after role injection (so the role opt-out is known).
 *
 * Split from `./cbm-access-experiment.ts` for the same reason as the
 * model-routing pair: a mocked `db` makes WHERE predicates unobservable, so
 * decisions are tested as pure functions and predicates by rendering to SQL.
 *
 * **Nothing here may fail a claim.** Every entry point catches, logs, and
 * answers "not enrolled" — which means CBM runs exactly as it does today.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db/client';
import { experimentAssignments, experiments } from './db/schema';
import {
  CBM_ACCESS_EXPERIMENT_KIND,
  CBM_WITHHELD_ARM,
  cbmPriorLookupIds,
  decideCbmArm,
  isCbmEligible,
  parseCbmAccessConfig,
  type CbmAccessArm,
  type CbmAccessExperimentRow,
  type CbmPriorAssignment,
} from './cbm-access-experiment';

const EXPERIMENT_TTL_MS = 60_000;
const experimentCache = new Map<string, { at: number; row: CbmAccessExperimentRow | null }>();

/** Drop the in-process cache. Call after any write to `experiments`; tests too. */
export function invalidateCbmAccessExperimentCache(teamId?: string): void {
  if (teamId) experimentCache.delete(teamId);
  else experimentCache.clear();
}

/** WHERE clause for "the team's running CBM-access experiment". */
export function runningCbmExperimentScope(teamId: string) {
  return and(
    eq(experiments.teamId, teamId),
    eq(experiments.status, 'running'),
    eq(experiments.kind, CBM_ACCESS_EXPERIMENT_KIND),
  );
}

export async function loadRunningCbmAccessExperiment(teamId: string): Promise<CbmAccessExperimentRow | null> {
  const hit = experimentCache.get(teamId);
  if (hit && Date.now() - hit.at < EXPERIMENT_TTL_MS) return hit.row;

  const rows = await db
    .select({
      id: experiments.id,
      kind: experiments.kind,
      status: experiments.status,
      treatmentFraction: experiments.treatmentFraction,
      policyVersion: experiments.policyVersion,
      config: experiments.config,
      startedAt: experiments.startedAt,
    })
    .from(experiments)
    .where(runningCbmExperimentScope(teamId));

  rows.sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
  const row = rows[0] ?? null;
  experimentCache.set(teamId, { at: Date.now(), row });
  return row;
}

/** WHERE clause for the prior assignments relevant to one claim. */
export function cbmPriorAssignmentsScope(experimentId: string, taskIds: string[]) {
  return and(
    eq(experimentAssignments.experimentId, experimentId),
    inArray(experimentAssignments.taskId, taskIds),
  );
}

/**
 * What the claim payload carries to the runner for an enrolled task. Both arms
 * carry it (so a worker log names its arm); only `withheld` changes behaviour.
 */
export interface CbmExperimentClaimMarker {
  experimentId: string;
  policyVersion: number;
  arm: CbmAccessArm;
  withheld: boolean;
}

export interface CbmEnrolArgs {
  teamId: string | null | undefined;
  task: {
    id: string;
    parentTaskId?: string | null;
    taskClass?: string | null;
    category?: string | null;
    kind?: string | null;
    complexity?: string | null;
    backend?: string | null;
    roleSlug?: string | null;
    context?: Record<string, unknown> | null;
    workspace?: { repo?: string | null } | null;
  };
  roleCbmDisabled: boolean;
  /** The claiming runner sent CBM_WITHHOLD_RUNNER_FEATURE. */
  runnerCanWithhold: boolean;
  runnerCliVersion?: string | null;
}

/**
 * Evaluate the team's running CBM-access experiment for one CLAIMED task,
 * record the assignment (idempotent on experiment+task), and return the
 * marker for the claim payload — or null when there is no running
 * experiment, the task is ineligible, or anything throws.
 *
 * Called after the claim lock, so every row written is for a task that really
 * was handed to a worker. The row is written BEFORE the marker is returned:
 * a withheld task always has its assignment and propensity on record, so its
 * outcome joins `task_outcomes` on task id like any other experiment row.
 */
export async function enrolCbmAccessExperiment(args: CbmEnrolArgs): Promise<CbmExperimentClaimMarker | null> {
  try {
    if (!args.teamId) return null;
    const experiment = await loadRunningCbmAccessExperiment(args.teamId);
    if (!experiment) return null;

    const config = parseCbmAccessConfig(experiment.config);
    const ctx = args.task.context ?? {};
    const lineage = {
      id: args.task.id,
      parentTaskId: args.task.parentTaskId,
      taskClass: args.task.taskClass,
      category: args.task.category,
      reviewerFor: ctx.reviewerFor,
    };

    const priorRows = await db
      .select({
        taskId: experimentAssignments.taskId,
        unitId: experimentAssignments.unitId,
        arm: experimentAssignments.arm,
        propensity: experimentAssignments.propensity,
      })
      .from(experimentAssignments)
      .where(cbmPriorAssignmentsScope(experiment.id, cbmPriorLookupIds(lineage)));

    const decision = decideCbmArm({
      experiment: { id: experiment.id, policyVersion: experiment.policyVersion, treatmentFraction: experiment.treatmentFraction },
      task: lineage,
      priors: priorRows as CbmPriorAssignment[],
      eligibility: () => isCbmEligible({
        backend: args.task.backend,
        runnerCanWithhold: args.runnerCanWithhold,
        hasRepo: !!args.task.workspace?.repo,
        roleCbmDisabled: args.roleCbmDisabled,
        taskClass: args.task.taskClass,
        kind: args.task.kind,
        category: args.task.category,
        reviewerFor: ctx.reviewerFor,
      }, config),
    });
    if (decision.source === 'ineligible') return null;

    if (decision.source !== 'existing') {
      await db.insert(experimentAssignments).values({
        experimentId: experiment.id,
        taskId: args.task.id,
        unitType: 'task',
        unitId: decision.unitId,
        arm: decision.arm,
        propensity: decision.propensity,
        policyVersion: experiment.policyVersion,
        // Model columns belong to model routing; this experiment does not
        // move the model, and task_outcomes records what actually ran.
        defaultModel: null,
        assignedModel: null,
        // Withholding is decided server-side and enforced by the runner on
        // every Claude path, so both arms are served as drawn.
        served: true,
        eligibility: {
          source: decision.source,
          kind: args.task.kind ?? null,
          complexity: args.task.complexity ?? null,
          roleSlug: args.task.roleSlug ?? null,
          cbm: decision.arm === CBM_WITHHELD_ARM ? 'withheld' : 'enforced',
          ...(decision.inheritedFromTaskId ? { inheritedFromTaskId: decision.inheritedFromTaskId } : {}),
        },
        runnerCliVersion: args.runnerCliVersion ?? null,
      }).onConflictDoNothing({ target: [experimentAssignments.experimentId, experimentAssignments.taskId] });
    }

    return {
      experimentId: experiment.id,
      policyVersion: experiment.policyVersion,
      arm: decision.arm,
      withheld: decision.arm === CBM_WITHHELD_ARM,
    };
  } catch (err) {
    console.warn(`[cbm-access-experiment] enrolment failed for task ${args.task.id}; CBM runs as configured:`, err);
    return null;
  }
}
