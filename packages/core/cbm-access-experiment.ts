/**
 * CBM-access experiment — the pure half.
 *
 * Question under test: does mounting the codebase graph (codebase-memory MCP)
 * change how often engineering work lands cleanly? The arm that matters is
 * the one WITHOUT the graph: CBM is enforced by default on every repo-backed
 * task, so the only way to learn its value is to withhold it from a random
 * share of eligible tasks and compare.
 *
 * Why this exists: the designed control was a role (`builder-nocbm`) whose
 * `workspace_skills.mcpServers['codebase-memory'] === false` makes the claim
 * route set `cbmDisabled`. Roles do not self-enrol — a task only gets one if a
 * human or the organizer routes it there — and nothing did, so the
 * `role_opt_out` skip reason never appeared on a worker and CBM was never A/B
 * tested (platform audit D15). This module is the randomiser that role never
 * had, drawn through the experiments registry like model routing.
 *
 * Arm mapping onto the registry's fixed `control | treatment` columns:
 *   - `control`   = CBM as it runs today (enforced by default).
 *   - `treatment` = CBM WITHHELD: no MCP mount, no graph steering, every CBM
 *                   tool on the deny list. The audit calls this "the no-CBM
 *                   control arm"; in the registry it is the treatment,
 *                   because `treatmentFraction` is the share that gets the
 *                   intervention and withholding is the intervention.
 *
 * Invariants:
 * - **Eligibility before the draw**, from facts the claim route has: a Claude
 *   backend (Codex mounts CBM differently and runs on another model, so it is
 *   a confounder, not a stratum), a repo-backed workspace, a graph-relevant
 *   kind, a `work` task, not a reviewer, and not a role that already opts out.
 * - **The unit is the task.** CBM changes one agent's navigation; it does not
 *   reach a sibling's session, so there is no mission-level spillover to
 *   cluster on (unlike model routing, whose premium work moves budget pacing).
 * - **Attempts inherit, never redraw.** A CI retry or reviewer rework is part
 *   of its parent's outcome; redrawing would credit one arm with the other's
 *   fix. A re-claim of the same task reuses its own row.
 */
import { assignExperimentArm } from './experiment-randomizer';
import { isReviewerTask, resolveInheritanceParent } from './experiment-lineage';

export const CBM_ACCESS_EXPERIMENT_KIND = 'cbm_access' as const;

export type CbmAccessArm = 'control' | 'treatment';

/** The arm that has CBM withheld. See the module header for the mapping. */
export const CBM_WITHHELD_ARM: CbmAccessArm = 'treatment';

/**
 * Task kinds where a structural graph can plausibly matter. `engineering` is
 * the core population; `research` and `analysis` read code to answer questions
 * about it. Coordination, writing, design and observation rarely navigate code,
 * so including them would dilute any effect with tasks that cannot show one.
 */
/**
 * The claim-request `runnerFeatures` entry a runner sends when it honours
 * `cbmExperiment.withheld`. A runner without it would ignore the marker and
 * run CBM anyway while the row says "withheld", so its tasks are not enrolled
 * in either arm (judged before the draw, so no selection effect on an arm).
 */
export const CBM_WITHHOLD_RUNNER_FEATURE = 'cbm_withhold';

export const DEFAULT_CBM_ELIGIBLE_KINDS: readonly string[] = ['engineering', 'research', 'analysis'];
export const DEFAULT_CBM_MIN_SAMPLE_PER_ARM = 30;

/** The `experiments` row fields this module reads. */
export interface CbmAccessExperimentRow {
  id: string;
  kind: string;
  status: string;
  treatmentFraction: number | string | null;
  policyVersion: number;
  config: unknown;
}

/** Resolved, validated `experiments.config` for kind `cbm_access`. */
export interface CbmAccessExperimentConfig {
  kinds: readonly string[];
  /** Enrol tasks with no stated `kind`. Off by default: an unkinded task may be anything. */
  includeUnkinded: boolean;
  minSamplePerArm: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Parse `experiments.config`. Every field falls back to its default rather
 * than failing: a malformed config must not break claiming.
 *
 * Shape: `{ eligibility: { kinds: string[], includeUnkinded: boolean }, minSamplePerArm }`.
 */
export function parseCbmAccessConfig(raw: unknown): CbmAccessExperimentConfig {
  const cfg = asRecord(raw);
  const elig = asRecord(cfg.eligibility);

  const k = elig.kinds;
  const kinds = Array.isArray(k) && k.length > 0 && k.every(x => typeof x === 'string' && x.length > 0)
    ? (k as string[])
    : DEFAULT_CBM_ELIGIBLE_KINDS;

  const includeUnkinded = elig.includeUnkinded === true;

  const m = cfg.minSamplePerArm;
  const minSamplePerArm = typeof m === 'number' && Number.isInteger(m) && m > 0
    ? m
    : DEFAULT_CBM_MIN_SAMPLE_PER_ARM;

  return { kinds, includeUnkinded, minSamplePerArm };
}

/** The config a new cbm_access experiment gets when the caller sends none. */
export function defaultCbmAccessConfig(): Record<string, unknown> {
  return {
    arms: { control: 'cbm_enforced', treatment: 'cbm_withheld' },
    eligibility: { kinds: [...DEFAULT_CBM_ELIGIBLE_KINDS], includeUnkinded: false },
    minSamplePerArm: DEFAULT_CBM_MIN_SAMPLE_PER_ARM,
  };
}

// ── Eligibility ─────────────────────────────────────────────────────────────

export type CbmIneligibleReason =
  | 'backend_not_claude'
  | 'runner_cannot_withhold'
  | 'no_repo'
  | 'role_cbm_disabled'
  | 'reviewer_task'
  | 'task_class_not_work'
  | 'kind_unstated'
  | 'kind_not_graph_relevant';

export interface CbmEligibilityInput {
  /** The FINAL backend, after any provider-toggle or budget-failover flip. */
  backend: string | null | undefined;
  /** The claiming runner declared CBM_WITHHOLD_RUNNER_FEATURE. */
  runnerCanWithhold: boolean;
  /** The task's workspace has a repo (CBM has nothing to index otherwise). */
  hasRepo: boolean;
  /** The claim already carries `cbmDisabled` from the role opt-out. */
  roleCbmDisabled: boolean;
  taskClass: string | null | undefined;
  kind: string | null | undefined;
  category: string | null | undefined;
  reviewerFor: unknown;
}

export type CbmEligibilityResult =
  | { eligible: true; reason: null }
  | { eligible: false; reason: CbmIneligibleReason };

export function isCbmEligible(input: CbmEligibilityInput, config: CbmAccessExperimentConfig): CbmEligibilityResult {
  const no = (reason: CbmIneligibleReason): CbmEligibilityResult => ({ eligible: false, reason });

  if ((input.backend ?? 'claude') !== 'claude') return no('backend_not_claude');
  if (!input.runnerCanWithhold) return no('runner_cannot_withhold');
  if (!input.hasRepo) return no('no_repo');
  // Already CBM-off by config: in either arm it would run without the graph,
  // which would put CBM-off tasks inside the control arm.
  if (input.roleCbmDisabled) return no('role_cbm_disabled');
  // Reviewers are held fixed (CBM on), as in the model-routing experiment.
  if (isReviewerTask(input.category, input.reviewerFor)) return no('reviewer_task');
  if ((input.taskClass ?? 'work') !== 'work') return no('task_class_not_work');
  if (!input.kind) return config.includeUnkinded ? { eligible: true, reason: null } : no('kind_unstated');
  if (!config.kinds.includes(input.kind)) return no('kind_not_graph_relevant');
  return { eligible: true, reason: null };
}

// ── Decision ────────────────────────────────────────────────────────────────

/** An existing assignment row, reduced to what inheritance needs. */
export interface CbmPriorAssignment {
  taskId: string;
  unitId: string;
  arm: CbmAccessArm;
  propensity: number;
}

export type CbmArmDecision =
  | { source: 'existing' | 'inherited' | 'drawn'; arm: CbmAccessArm; propensity: number; unitId: string; inheritedFromTaskId: string | null }
  | { source: 'ineligible'; reason: CbmIneligibleReason };

/**
 * Decide this task's arm, in precedence order:
 *
 *   1. The task already has a row (a re-claim after a worker died) → reuse it,
 *      without re-judging eligibility.
 *   2. Its lineage parent has a row → inherit that arm and unit.
 *   3. Otherwise judge eligibility, then draw on the task id.
 *
 * An attempt whose parent was never enrolled falls to 3 and is ineligible
 * (`task_class_not_work`) — attempts never draw on their own.
 */
export function decideCbmArm(args: {
  experiment: { id: string; policyVersion: number; treatmentFraction: unknown };
  task: {
    id: string;
    parentTaskId?: string | null;
    taskClass?: string | null;
    category?: string | null;
    reviewerFor?: unknown;
  };
  priors: CbmPriorAssignment[];
  eligibility: () => CbmEligibilityResult;
}): CbmArmDecision {
  const own = args.priors.find(p => p.taskId === args.task.id);
  if (own) {
    return { source: 'existing', arm: own.arm, propensity: own.propensity, unitId: own.unitId, inheritedFromTaskId: null };
  }
  const parentId = resolveInheritanceParent(args.task);
  if (parentId) {
    const parent = args.priors.find(p => p.taskId === parentId);
    if (parent) {
      return { source: 'inherited', arm: parent.arm, propensity: parent.propensity, unitId: parent.unitId, inheritedFromTaskId: parent.taskId };
    }
  }
  const e = args.eligibility();
  if (!e.eligible) return { source: 'ineligible', reason: e.reason };

  const a = assignExperimentArm<CbmAccessArm>({
    experimentId: args.experiment.id,
    policyVersion: String(args.experiment.policyVersion),
    controlArm: 'control',
    treatmentArm: 'treatment',
    unitId: args.task.id,
    fraction: args.experiment.treatmentFraction,
  });
  return { source: 'drawn', arm: a.arm, propensity: a.propensity, unitId: args.task.id, inheritedFromTaskId: null };
}

/** The ids whose prior rows `decideCbmArm` may need: the task, and its lineage parent. */
export function cbmPriorLookupIds(task: Parameters<typeof resolveInheritanceParent>[0] & { id: string }): string[] {
  const parentId = resolveInheritanceParent(task);
  return parentId ? [task.id, parentId] : [task.id];
}
