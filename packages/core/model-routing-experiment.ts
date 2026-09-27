/**
 * Model-routing experiment — the pure half.
 *
 * Question under test: for work the router would send to the `standard` tier
 * on its baseline path, does serving the `premium` tier instead change how
 * often the work lands cleanly? See docs/design/model-routing-experiment.md.
 *
 * Everything here is a function of its arguments — no db, no clock, no env —
 * so eligibility, unit resolution, the draw, and inheritance are each tested
 * against literal inputs. The claim-route glue that loads the experiment row
 * and writes the assignment lives in `./model-routing-experiment-source.ts`.
 *
 * Invariants this module exists to hold:
 *
 * - **Eligibility is judged before the draw**, from the router's own output,
 *   so the arms are drawn from one population. Anything that pins a model
 *   (explicit id, task tier, role model) or moves it off the baseline (budget
 *   or spike downshift, role floor clamp) is excluded, never re-routed.
 * - **The unit is the mission when there is one.** Tasks in a mission share a
 *   plan, a branch and often a reviewer; randomising them independently would
 *   put both arms inside one mission and let them contaminate each other.
 * - **Attempts inherit, never redraw.** A CI retry, conflict retry or reviewer
 *   rework is part of its parent's outcome. Redrawing would let a treatment
 *   task's retry run on the control model and credit the control with the fix.
 * - **Capability fallback does not defer.** If the treatment model needs a
 *   newer client than the runner has, the task runs the control model and the
 *   row records `served: false`. Deferring would drop exactly the treatment
 *   tasks that landed on old runners — a selection effect on the arm.
 */
import { assignExperimentArm, resolveEnrolmentFraction } from './experiment-randomizer';
import { isReviewerTask, resolveInheritanceParent } from './experiment-lineage';
import { mapRouterAlias } from './model-tier-registry';
import { TIERS, type Tier as RegistryTier } from './model-tier-defaults';

// Lineage rules are shared with the CBM-access experiment; re-exported so
// existing importers of this module keep resolving.
export { isReviewerTask, resolveInheritanceParent };

export const MODEL_ROUTING_EXPERIMENT_KIND = 'model_routing' as const;

export type ModelRoutingArm = 'control' | 'treatment';

/** Budget pressure above which a task is not enrolled (0..1, same scale as the router's dailyBudgetPct). */
export const DEFAULT_MAX_BUDGET_PRESSURE = 0.5;
export const DEFAULT_TREATMENT_TIER: RegistryTier = 'premium';
export const DEFAULT_MIN_SAMPLE_PER_ARM = 30;

/** The `experiments` row fields this module reads. */
export interface ModelRoutingExperimentRow {
  id: string;
  kind: string;
  status: string;
  treatmentFraction: number | string | null;
  policyVersion: number;
  config: unknown;
}

/** Resolved, validated `experiments.config` for kind `model_routing`. */
export interface ModelRoutingExperimentConfig {
  treatmentTier: RegistryTier;
  maxBudgetPressure: number;
  minSamplePerArm: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Parse `experiments.config`. Every field falls back to its default rather
 * than failing: a malformed config must not break claiming, and every fallback
 * is the conservative reading (premium treatment, the default pressure cap).
 *
 * Shape: `{ arms: { treatment: { tier } }, eligibility: { maxBudgetPressure }, minSamplePerArm }`.
 */
export function parseModelRoutingConfig(raw: unknown): ModelRoutingExperimentConfig {
  const cfg = asRecord(raw);
  const arms = asRecord(cfg.arms);
  const treatment = asRecord(arms.treatment);
  const elig = asRecord(cfg.eligibility);

  const tier = treatment.tier;
  const treatmentTier = typeof tier === 'string' && (TIERS as readonly string[]).includes(tier)
    ? (tier as RegistryTier)
    : DEFAULT_TREATMENT_TIER;

  const p = elig.maxBudgetPressure;
  const maxBudgetPressure = typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1
    ? p
    : DEFAULT_MAX_BUDGET_PRESSURE;

  const m = cfg.minSamplePerArm;
  const minSamplePerArm = typeof m === 'number' && Number.isInteger(m) && m > 0
    ? m
    : DEFAULT_MIN_SAMPLE_PER_ARM;

  return { treatmentTier, maxBudgetPressure, minSamplePerArm };
}

// ── Eligibility ─────────────────────────────────────────────────────────────

export type IneligibleReason =
  | 'backend_not_claude'
  | 'explicit_model'
  | 'task_tier_pinned'
  | 'role_model_pinned'
  | 'router_not_baseline'
  | 'tier_not_standard'
  | 'task_class_not_work'
  | 'kind_observation'
  | 'reviewer_task'
  | 'budget_pressure';

export interface EligibilityInput {
  backend: string | null | undefined;
  /** `task.context.model`, if any. */
  explicitModel: string | null | undefined;
  /** `task.tier`. */
  taskTier: string | null | undefined;
  /** The role's configured model (alias or full id), or null. */
  roleModel: string | null | undefined;
  /** `resolveEffectiveModel(...).reason`. */
  routerReason: string;
  /** `resolveEffectiveModel(...).model` — a router alias. */
  routerModel: string;
  taskClass: string | null | undefined;
  kind: string | null | undefined;
  category: string | null | undefined;
  /** `task.context.reviewerFor`, set on reviewer tasks. */
  reviewerFor: unknown;
  /** 0..1, the router's `dailyBudgetPct`. */
  budgetPressure: number;
  maxBudgetPressure: number;
}

export type EligibilityResult =
  | { eligible: true; reason: null }
  | { eligible: false; reason: IneligibleReason };

/**
 * Is this task in the population the experiment compares?
 *
 * Checks are ordered pin-first so the recorded reason names the most
 * fundamental exclusion (a pinned model is excluded whatever the budget).
 */
export function isEligible(input: EligibilityInput): EligibilityResult {
  const no = (reason: IneligibleReason): EligibilityResult => ({ eligible: false, reason });

  if ((input.backend ?? 'claude') !== 'claude') return no('backend_not_claude');
  if (input.explicitModel) return no('explicit_model');
  if (input.taskTier) return no('task_tier_pinned');
  if (input.roleModel && input.roleModel !== 'inherit') return no('role_model_pinned');
  if (isReviewerTask(input.category, input.reviewerFor)) return no('reviewer_task');
  if ((input.taskClass ?? 'work') !== 'work') return no('task_class_not_work');
  if (input.kind === 'observation') return no('kind_observation');
  if (input.routerReason !== 'baseline') return no('router_not_baseline');
  if (mapRouterAlias(input.routerModel) !== 'standard') return no('tier_not_standard');
  if (!(input.budgetPressure < input.maxBudgetPressure)) return no('budget_pressure');
  return { eligible: true, reason: null };
}

// ── Unit ────────────────────────────────────────────────────────────────────

export interface UnitRef {
  unitType: 'mission' | 'task';
  unitId: string;
}

/** The randomisation unit: the mission when the task has one, else the task. */
export function resolveUnit(task: { id: string; missionId?: string | null }): UnitRef {
  return task.missionId
    ? { unitType: 'mission', unitId: task.missionId }
    : { unitType: 'task', unitId: task.id };
}

// ── Draw ────────────────────────────────────────────────────────────────────

export interface ArmDraw {
  arm: ModelRoutingArm;
  propensity: number;
}

/**
 * Draw an arm for a unit. Delegates to the shared randomiser — same hash,
 * same salt shape, same out-of-range-means-control semantics — so the draw is
 * reproducible offline from (experimentId, policyVersion, unitId) alone.
 */
export function assignArm(args: {
  experimentId: string;
  policyVersion: number;
  unitId: string;
  treatmentFraction: unknown;
}): ArmDraw {
  const a = assignExperimentArm<ModelRoutingArm>({
    experimentId: args.experimentId,
    policyVersion: String(args.policyVersion),
    controlArm: 'control',
    treatmentArm: 'treatment',
    unitId: args.unitId,
    fraction: args.treatmentFraction,
  });
  return { arm: a.arm, propensity: a.propensity };
}

// ── Inheritance ─────────────────────────────────────────────────────────────

// resolveInheritanceParent lives in ./experiment-lineage (re-exported above).

/** An existing assignment row, reduced to what inheritance needs. */
export interface PriorAssignment {
  taskId: string;
  unitType: 'mission' | 'task';
  unitId: string;
  arm: ModelRoutingArm;
  propensity: number;
}

export type ArmDecision =
  | { source: 'existing'; arm: ModelRoutingArm; propensity: number; unit: UnitRef; inheritedFromTaskId: string | null }
  | { source: 'inherited'; arm: ModelRoutingArm; propensity: number; unit: UnitRef; inheritedFromTaskId: string }
  | { source: 'drawn'; arm: ModelRoutingArm; propensity: number; unit: UnitRef; inheritedFromTaskId: null }
  | { source: 'ineligible'; reason: IneligibleReason };

/**
 * Decide this task's arm, in precedence order:
 *
 *   1. The task already has a row (a re-claim) → reuse it. Eligibility is NOT
 *      re-judged: the first claim writes the served model into
 *      `context.model`, so a re-claim would read as `explicit_model` and fall
 *      out of the experiment it is already in.
 *   2. Its lineage parent has a row → inherit that arm and unit.
 *   3. Otherwise judge eligibility, then draw on the unit.
 */
export function decideArm(args: {
  experiment: { id: string; policyVersion: number; treatmentFraction: unknown };
  task: { id: string; missionId?: string | null };
  inheritanceParentId: string | null;
  priors: PriorAssignment[];
  eligibility: () => EligibilityResult;
}): ArmDecision {
  const own = args.priors.find(p => p.taskId === args.task.id);
  if (own) {
    return {
      source: 'existing', arm: own.arm, propensity: own.propensity,
      unit: { unitType: own.unitType, unitId: own.unitId }, inheritedFromTaskId: null,
    };
  }
  if (args.inheritanceParentId) {
    const parent = args.priors.find(p => p.taskId === args.inheritanceParentId);
    if (parent) {
      return {
        source: 'inherited', arm: parent.arm, propensity: parent.propensity,
        unit: { unitType: parent.unitType, unitId: parent.unitId },
        inheritedFromTaskId: parent.taskId,
      };
    }
  }
  const e = args.eligibility();
  if (!e.eligible) return { source: 'ineligible', reason: e.reason };

  const unit = resolveUnit(args.task);
  const draw = assignArm({
    experimentId: args.experiment.id,
    policyVersion: args.experiment.policyVersion,
    unitId: unit.unitId,
    treatmentFraction: args.experiment.treatmentFraction,
  });
  return { source: 'drawn', ...draw, unit, inheritedFromTaskId: null };
}

/**
 * Can the treatment tier be applied to this claim at all? Only on the router's
 * tier path — an explicit override (including a sticky `context.model` from an
 * earlier claim) already carries a concrete model and is left alone, as is a
 * task that pinned its own tier or runs on another backend.
 */
export function treatmentApplicable(args: {
  routerReason: string;
  taskTier: string | null | undefined;
  backend: string | null | undefined;
}): boolean {
  return args.routerReason !== 'explicit_override'
    && !args.taskTier
    && (args.backend ?? 'claude') === 'claude';
}

/** Re-export so callers validating a fraction use the randomiser's own rule. */
export { resolveEnrolmentFraction };
