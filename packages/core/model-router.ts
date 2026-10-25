/**
 * Smart model routing — resolves the effective model for a task at claim time.
 *
 * Input: task metadata (kind, complexity, explicit overrides), runtime signals
 * (budget pressure, recent claim rate), and workspace role floor.
 * Output: one of the three short aliases — `haiku`, `sonnet`, `opus` —
 * or a full model ID when an explicit override was provided.
 *
 * See plans/buildd/smart-model-routing.md for the taxonomy, matrix, and gates.
 * The router is a pure function; the claim route computes the inputs and
 * records the output on `tasks.predictedModel`.
 */

export type Tier = 'haiku' | 'sonnet' | 'opus';

export type TaskKind =
  | 'coordination'
  | 'engineering'
  | 'research'
  | 'writing'
  | 'design'
  | 'analysis'
  | 'observation';

export type TaskComplexity = 'simple' | 'normal' | 'complex';

export interface RouterInput {
  /** Explicit model override from task.context.model — bypasses all gates. */
  explicitModel?: string | null;
  kind?: TaskKind | null;
  complexity?: TaskComplexity | null;
  /** Workspace role's configured model ('inherit' | tier | null for unset). */
  roleFloor?: Tier | 'inherit' | null;
  /** 0..1 — totalCostToday / account.maxCostPerDay. */
  dailyBudgetPct?: number;
  /** Number of tasks this account has claimed in the last 10 minutes. */
  recentClaimCount?: number;
  /** Threshold above which the spike gate fires. Default 20. */
  spikeThreshold?: number;
  /** Task priority (higher = more urgent). Priority > 0 bypasses the 95%+ pause. */
  priority?: number;
  /** Task title — a diagnosis title (see isDiagnosisTitle) gets an Opus floor. */
  title?: string | null;
}

export interface RouterDecision {
  /** The model alias or full ID to use. */
  model: string;
  /** Which reason determined the outcome — useful for analytics/debugging. */
  reason:
    | 'explicit_override'
    | 'baseline'
    | 'budget_downshift'
    | 'spike_downshift'
    | 'role_floor_clamp'
    | 'diagnosis_floor'
    | 'paused';
  /** True if a downshift was applied relative to the baseline. */
  downshifted: boolean;
  /** Baseline tier before any gates fired. */
  baseline: Tier;
}

/**
 * Baseline model matrix — kind × complexity → tier.
 * `coordination` and `observation` ignore complexity.
 *
 * Exported so routing-analytics.ts can compare a recorded prediction against
 * the same table the router decided with — it used to keep a hand-copied
 * duplicate that drifted out of sync.
 */
export const BASELINE: Record<TaskKind, Record<TaskComplexity, Tier>> = {
  coordination: { simple: 'sonnet', normal: 'sonnet', complex: 'opus' },
  engineering:  { simple: 'haiku', normal: 'sonnet', complex: 'opus' },
  research:     { simple: 'haiku', normal: 'sonnet', complex: 'sonnet' },
  writing:      { simple: 'haiku', normal: 'sonnet', complex: 'sonnet' },
  design:       { simple: 'sonnet', normal: 'opus', complex: 'opus' },
  analysis:     { simple: 'haiku', normal: 'sonnet', complex: 'sonnet' },
  observation:  { simple: 'haiku', normal: 'haiku', complex: 'haiku' },
};

/** The closed `tasks.kind` vocabulary, as a runtime value. */
export const TASK_KIND_VALUES: readonly TaskKind[] = Object.freeze(
  Object.keys(BASELINE) as TaskKind[],
);

export function isRouterTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BASELINE, value);
}

/**
 * Category values (`tasks.category`) that are sometimes written where a kind
 * belongs. Anything not listed here and not a kind maps to `engineering`.
 */
const CATEGORY_TO_KIND: Readonly<Record<string, TaskKind>> = Object.freeze({
  docs: 'writing',
});

/**
 * Coerce any stored or supplied kind onto the closed vocabulary.
 *
 * `tasks.kind` is a plain text column (its `$type<>` is compile-time only), so
 * a category value such as 'feature' or 'test' can reach a reader. Null/empty
 * stays null (no signal); a valid kind passes through; a known category maps
 * to its closest kind; anything else becomes `engineering`, the router default.
 */
export function normalizeTaskKind(value: unknown): TaskKind | null {
  if (value === null || value === undefined || value === '') return null;
  if (isRouterTaskKind(value)) return value;
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATEGORY_TO_KIND, value)) {
    return CATEGORY_TO_KIND[value];
  }
  return 'engineering';
}

/**
 * Titles of diagnosis work: friction reports, incidents and release-candidate
 * fixes. Their filer picks whatever kind comes to mind (usually engineering or
 * analysis, often with no complexity), which the matrix routes to Sonnet, and a
 * shallow diagnosis is worse than none: it reads as investigated. They get an
 * Opus floor, and budget/spike pressure does not downshift them — only the 95%+
 * pause still applies. An explicit tasks.tier or pin still outranks this.
 */
const DIAGNOSIS_TITLE_RE = /^\s*(?:\[friction\]|\[incident\]|fix\(release\):)/i;

export function isDiagnosisTitle(title: string | null | undefined): boolean {
  return typeof title === 'string' && DIAGNOSIS_TITLE_RE.test(title);
}

const COMPLEXITIES: ReadonlySet<string> = new Set(['simple', 'normal', 'complex']);

const TIER_ORDER: Tier[] = ['haiku', 'sonnet', 'opus'];

function downshift(tier: Tier, steps = 1): Tier {
  const idx = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.max(0, idx - steps)];
}

function isHigherOrEqual(a: Tier, b: Tier): boolean {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b);
}

export function resolveEffectiveModel(input: RouterInput): RouterDecision {
  const {
    explicitModel,
    kind: kindInput,
    complexity: complexityInput,
    roleFloor,
    dailyBudgetPct = 0,
    recentClaimCount = 0,
    spikeThreshold = 20,
    priority = 0,
    title,
  } = input;

  // 1. Explicit override wins unconditionally.
  if (explicitModel) {
    return {
      model: explicitModel,
      reason: 'explicit_override',
      downshifted: false,
      baseline: 'opus',
    };
  }

  // Never index BASELINE with an unchecked value: an out-of-vocabulary kind
  // (e.g. a category like 'feature') used to throw here and 500 every claim
  // whose candidate set held that task.
  const kind: TaskKind = normalizeTaskKind(kindInput) ?? 'engineering';
  const complexity: TaskComplexity =
    complexityInput && COMPLEXITIES.has(complexityInput) ? complexityInput : 'normal';
  const matrix = BASELINE[kind]?.[complexity] ?? BASELINE.engineering[complexity];
  const diagnosis = isDiagnosisTitle(title);
  const baseline: Tier = diagnosis ? 'opus' : matrix;

  // 2. Budget-pressure gate — see the table in plans/buildd/smart-model-routing.md.
  let tier = baseline;
  let reason: RouterDecision['reason'] = diagnosis && matrix !== 'opus' ? 'diagnosis_floor' : 'baseline';

  if (diagnosis) {
    if (dailyBudgetPct >= 0.95 && priority <= 0) {
      return { model: 'paused', reason: 'paused', downshifted: true, baseline };
    }
    return { model: baseline, reason, downshifted: false, baseline };
  }

  if (dailyBudgetPct >= 0.95) {
    // 95%+: coordination forced to Sonnet; everything else pauses unless
    // priority > 0 (in which case it still runs but downshifted one tier).
    if (kind === 'coordination') {
      tier = 'sonnet';
      reason = 'budget_downshift';
    } else if (priority > 0) {
      tier = downshift(tier);
      reason = 'budget_downshift';
    } else {
      return { model: 'paused', reason: 'paused', downshifted: true, baseline };
    }
  } else if (dailyBudgetPct >= 0.9) {
    // 90–95%: downshift everything except coordination (coordination stays at
    // baseline/opus until 95%+).
    if (kind !== 'coordination') {
      tier = downshift(tier);
      reason = 'budget_downshift';
    }
  } else if (dailyBudgetPct >= 0.7) {
    // 70–90%: downshift engineering/writing/analysis only.
    if (kind === 'engineering' || kind === 'writing' || kind === 'analysis') {
      tier = downshift(tier);
      reason = 'budget_downshift';
    }
  }

  // 3. Spike-detection gate — fires only if budget gate didn't already downshift.
  if (reason === 'baseline' && recentClaimCount > spikeThreshold) {
    if (kind === 'engineering' || kind === 'writing' || kind === 'analysis') {
      tier = downshift(tier);
      reason = 'spike_downshift';
    }
  }

  // 4. Role floor — if workspace pins a minimum model, never go below it.
  if (roleFloor && roleFloor !== 'inherit') {
    if (!isHigherOrEqual(tier, roleFloor)) {
      tier = roleFloor;
      reason = 'role_floor_clamp';
    }
  }

  return {
    model: tier,
    reason,
    downshifted: TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(baseline),
    baseline,
  };
}
