/**
 * Model-routing experiment — the stores half, called from the claim route.
 *
 * Split from `./model-routing-experiment.ts` for the reason every experiment
 * module here is split: mocking `db` makes WHERE predicates unobservable, so
 * the decisions are tested as pure functions and the predicates are tested by
 * rendering them to SQL (see __tests__/model-routing-experiment-source.test.ts).
 *
 * **Nothing here may fail or defer a claim.** Every entry point catches, logs,
 * and returns the "no experiment" answer. An experiment that cannot be
 * evaluated means the task runs exactly as routed.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db/client';
import { experimentAssignments, experiments } from './db/schema';
import {
  MODEL_ROUTING_EXPERIMENT_KIND,
  decideArm,
  isEligible,
  parseModelRoutingConfig,
  resolveInheritanceParent,
  treatmentApplicable,
  type EligibilityInput,
  type ModelRoutingArm,
  type ModelRoutingExperimentRow,
  type PriorAssignment,
} from './model-routing-experiment';
import type { Tier as RegistryTier } from './model-tier-defaults';

// ── Experiment lookup (cached) ──────────────────────────────────────────────

/**
 * Same TTL as the task-area config and the tier registry: short enough that
 * pausing an experiment takes effect within a minute, long enough that a
 * claim burst costs one query per team per minute, not one per task.
 */
const EXPERIMENT_TTL_MS = 60_000;
const experimentCache = new Map<string, { at: number; row: ModelRoutingExperimentRow | null }>();

/** Drop the in-process cache. Call after any write to `experiments`; tests too. */
export function invalidateModelRoutingExperimentCache(teamId?: string): void {
  if (teamId) experimentCache.delete(teamId);
  else experimentCache.clear();
}

/** WHERE clause for "the team's running model-routing experiment". */
export function runningExperimentScope(teamId: string) {
  return and(
    eq(experiments.teamId, teamId),
    eq(experiments.status, 'running'),
    eq(experiments.kind, MODEL_ROUTING_EXPERIMENT_KIND),
  );
}

/**
 * The team's running model-routing experiment, or null. If a team somehow has
 * two running, the most recently started wins — deterministic, and a second
 * concurrent experiment on the same population would be a design error the
 * write surface should refuse, not something to arbitrate per claim.
 */
export async function loadRunningModelRoutingExperiment(teamId: string): Promise<ModelRoutingExperimentRow | null> {
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
    .where(runningExperimentScope(teamId));

  rows.sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
  const row = rows[0] ?? null;
  experimentCache.set(teamId, { at: Date.now(), row });
  return row;
}

/** WHERE clause for the prior assignments relevant to one claim. */
export function priorAssignmentsScope(experimentId: string, taskIds: string[]) {
  return and(
    eq(experimentAssignments.experimentId, experimentId),
    inArray(experimentAssignments.taskId, taskIds),
  );
}

// ── Claim-time draw ─────────────────────────────────────────────────────────

/** The per-claim experiment state threaded from draw → apply → record. */
export interface ClaimExperimentDraw {
  experimentId: string;
  policyVersion: number;
  arm: ModelRoutingArm;
  propensity: number;
  unitType: 'mission' | 'task';
  unitId: string;
  treatmentTier: RegistryTier;
  /** True when a row already exists for this task — nothing to insert. */
  alreadyRecorded: boolean;
  eligibility: Record<string, unknown>;
  /** The model the router would have served with no experiment. */
  defaultModel: string | null;
  assignedModel: string | null;
  served: boolean;
}

export interface DrawForClaimArgs {
  teamId: string | null | undefined;
  task: {
    id: string;
    missionId?: string | null;
    parentTaskId?: string | null;
    taskClass?: string | null;
    category?: string | null;
    kind?: string | null;
    complexity?: string | null;
    tier?: string | null;
    backend?: string | null;
    roleSlug?: string | null;
    context?: Record<string, unknown> | null;
  };
  /**
   * The explicit model the claim route derived for this task (today
   * `context.model`). Passed in rather than re-read from context so that when
   * the route learns to tell a user pin from a model an earlier claim wrote,
   * eligibility follows without a second copy of that rule.
   */
  explicitModel: string | null;
  routerReason: string;
  routerModel: string;
  roleModel: string | null;
  budgetPressure: number;
}

/**
 * Evaluate the team's running experiment for one candidate task. Returns null
 * when there is no experiment, the task is ineligible, or anything throws.
 */
export async function drawModelRoutingArm(args: DrawForClaimArgs): Promise<ClaimExperimentDraw | null> {
  try {
    if (!args.teamId) return null;
    const experiment = await loadRunningModelRoutingExperiment(args.teamId);
    if (!experiment) return null;

    const config = parseModelRoutingConfig(experiment.config);
    const ctx = args.task.context ?? {};
    const parentId = resolveInheritanceParent({
      parentTaskId: args.task.parentTaskId,
      taskClass: args.task.taskClass,
      category: args.task.category,
      reviewerFor: ctx.reviewerFor,
    });

    const lookupIds = parentId ? [args.task.id, parentId] : [args.task.id];
    const priorRows = await db
      .select({
        taskId: experimentAssignments.taskId,
        unitType: experimentAssignments.unitType,
        unitId: experimentAssignments.unitId,
        arm: experimentAssignments.arm,
        propensity: experimentAssignments.propensity,
      })
      .from(experimentAssignments)
      .where(priorAssignmentsScope(experiment.id, lookupIds));

    const eligibilityInput: EligibilityInput = {
      backend: args.task.backend,
      explicitModel: args.explicitModel,
      taskTier: args.task.tier,
      roleModel: args.roleModel,
      routerReason: args.routerReason,
      routerModel: args.routerModel,
      taskClass: args.task.taskClass,
      kind: args.task.kind,
      category: args.task.category,
      reviewerFor: ctx.reviewerFor,
      budgetPressure: args.budgetPressure,
      maxBudgetPressure: config.maxBudgetPressure,
    };

    const decision = decideArm({
      experiment: {
        id: experiment.id,
        policyVersion: experiment.policyVersion,
        treatmentFraction: experiment.treatmentFraction,
      },
      task: { id: args.task.id, missionId: args.task.missionId },
      inheritanceParentId: parentId,
      priors: priorRows as PriorAssignment[],
      eligibility: () => isEligible(eligibilityInput),
    });
    if (decision.source === 'ineligible') return null;

    return {
      experimentId: experiment.id,
      policyVersion: experiment.policyVersion,
      arm: decision.arm,
      propensity: decision.propensity,
      unitType: decision.unit.unitType,
      unitId: decision.unit.unitId,
      treatmentTier: config.treatmentTier,
      alreadyRecorded: decision.source === 'existing',
      eligibility: {
        source: decision.source,
        budgetPressure: args.budgetPressure,
        kind: args.task.kind ?? null,
        complexity: args.task.complexity ?? null,
        roleSlug: args.task.roleSlug ?? null,
        ...(decision.inheritedFromTaskId ? { inheritedFromTaskId: decision.inheritedFromTaskId } : {}),
      },
      defaultModel: null,
      assignedModel: null,
      // Control is served as routed by definition; treatment is proven served
      // only once applyModelRoutingTreatment picks the treatment model.
      served: decision.arm === 'control',
    };
  } catch (err) {
    console.warn(`[model-routing-experiment] draw failed for task ${args.task.id}; running as routed:`, err);
    return null;
  }
}

/**
 * Resolve the model a treatment claim should run. Called with the control
 * model already resolved. Returns the tier entry to use instead, or null to
 * keep the control model — which is also the answer for control-arm draws,
 * for claims where the treatment cannot apply, when the runner's client
 * cannot serve the treatment model, and on any error.
 *
 * Mutates `draw.defaultModel` / `draw.assignedModel` / `draw.served` so the
 * later record step writes what actually happened.
 */
export async function applyModelRoutingTreatment(
  draw: ClaimExperimentDraw,
  args: {
    controlModel: string;
    routerReason: string;
    taskTier: string | null | undefined;
    backend: string | null | undefined;
    resolveTier: (tier: RegistryTier) => Promise<{ model: string; provider: string; source?: string }>;
    clientCanServe: (model: string) => boolean;
  },
): Promise<{ tier: RegistryTier; model: string; provider: string; source?: string } | null> {
  draw.defaultModel = args.controlModel;
  draw.assignedModel = args.controlModel;
  if (draw.arm !== 'treatment') return null;
  try {
    if (!treatmentApplicable({ routerReason: args.routerReason, taskTier: args.taskTier, backend: args.backend })) {
      draw.served = false;
      return null;
    }
    const entry = await args.resolveTier(draw.treatmentTier);
    if (!args.clientCanServe(entry.model)) {
      // Fall back, do not defer: see the module header of model-routing-experiment.ts.
      draw.served = false;
      draw.eligibility = { ...draw.eligibility, fallback: 'client_capability' };
      return null;
    }
    draw.assignedModel = entry.model;
    draw.served = true;
    return { tier: draw.treatmentTier, ...entry };
  } catch (err) {
    console.warn(`[model-routing-experiment] treatment resolution failed; serving control:`, err);
    draw.served = false;
    return null;
  }
}

/**
 * Persist the assignment. Idempotent on (experiment_id, task_id): a re-claim,
 * or two racing claims, write one row. Never throws.
 */
export async function recordModelRoutingAssignment(
  draw: ClaimExperimentDraw,
  args: {
    taskId: string;
    runnerCliVersion: string | null | undefined;
    /** The model the claim finally wrote — covers paths that never reached applyModelRoutingTreatment. */
    resolvedModel: string;
  },
): Promise<void> {
  if (draw.alreadyRecorded) return;
  try {
    await db.insert(experimentAssignments).values({
      experimentId: draw.experimentId,
      taskId: args.taskId,
      unitType: draw.unitType,
      unitId: draw.unitId,
      arm: draw.arm,
      propensity: draw.propensity,
      policyVersion: draw.policyVersion,
      defaultModel: draw.defaultModel,
      assignedModel: draw.assignedModel ?? args.resolvedModel,
      served: draw.served,
      eligibility: draw.eligibility,
      runnerCliVersion: args.runnerCliVersion ?? null,
    }).onConflictDoNothing({ target: [experimentAssignments.experimentId, experimentAssignments.taskId] });
  } catch (err) {
    console.warn(`[model-routing-experiment] failed to record assignment for task ${args.taskId}:`, err);
  }
}
