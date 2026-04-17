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
    | 'paused';
  /** True if a downshift was applied relative to the baseline. */
  downshifted: boolean;
  /** Baseline tier before any gates fired. */
  baseline: Tier;
}

/**
 * Baseline model matrix — kind × complexity → tier.
 * `coordination` and `observation` ignore complexity.
 */
const BASELINE: Record<TaskKind, Record<TaskComplexity, Tier>> = {
  coordination: { simple: 'opus', normal: 'opus', complex: 'opus' },
  engineering:  { simple: 'haiku', normal: 'sonnet', complex: 'opus' },
  research:     { simple: 'haiku', normal: 'sonnet', complex: 'sonnet' },
  writing:      { simple: 'haiku', normal: 'sonnet', complex: 'sonnet' },
  design:       { simple: 'sonnet', normal: 'opus', complex: 'opus' },
  analysis:     { simple: 'haiku', normal: 'sonnet', complex: 'sonnet' },
  observation:  { simple: 'haiku', normal: 'haiku', complex: 'haiku' },
};

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

  const kind: TaskKind = kindInput || 'engineering';
  const complexity: TaskComplexity = complexityInput || 'normal';
  const baseline = BASELINE[kind][complexity];

  // 2. Budget-pressure gate — see the table in plans/buildd/smart-model-routing.md.
  let tier = baseline;
  let reason: RouterDecision['reason'] = 'baseline';

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
