/**
 * Replayable evaluation for claim-time HOLD/START policies
 * (./orchestration-claim-risk.ts; the live readout is ./orchestration-claim-readout.ts).
 *
 * A labelled scenario is one overlap candidate at claim time plus what
 * actually happened to the pair. Any policy (the risk profile, a rule
 * baseline, a model's answers replayed from the ledger) is scored on the same
 * scenarios, so a prompt or threshold change can be measured even when the
 * live sample is thin.
 *
 * Labelling rules, the same ones the live readout keeps:
 *
 *  - **Held pairs are censored.** A pair that never ran concurrently has no
 *    observed counterfactual. It is never labelled conflict-free and never
 *    counts toward a false-positive hold rate; it is reported as censored.
 *  - **Outcome classes stay separate.** A clean merge-tree, a Mergiraf
 *    structural resolution, a mechanical rebase, a real Git conflict needing
 *    repair, a downstream CI regression, a human intervention and a migration
 *    index collision are different events with different costs. Only the
 *    last four are harm; a rebase is cost, not harm.
 *  - **Utility, not just accuracy.** Every scenario may carry the minutes a
 *    hold cost (wait) and a bad start cost (repair). A policy that holds
 *    everything scores zero unsafe starts and a large wait; both are shown.
 *
 * Scenarios carry a frozen `split` (train / heldout / later) so a policy tuned
 * on one split is scored on another. Pure: no DB.
 */
import { assessClaimOverlapRisk, type ClaimRiskAssessment, type ClaimRiskInput, type ClaimRiskTier } from './orchestration-claim-risk';

export type PairOutcome =
  /** Both ran; their branches merged cleanly. */
  | 'clean_merge_tree'
  /** Both ran; Git conflicted, Mergiraf resolved it structurally. */
  | 'mergiraf_resolved'
  /** Both ran; the later one needed a mechanical rebase, no repair task. */
  | 'rebase_required'
  /** Both ran; a real conflict needed a repair attempt (agent or person). */
  | 'git_conflict'
  /** Both ran and merged clean; CI or behaviour broke downstream. */
  | 'ci_semantic_regression'
  /** Both ran; a person had to step in (cancel, hand-merge, rewrite). */
  | 'human_intervention'
  /** A migration-number collision: a distinct class, never a soft overlap. */
  | 'migration_index_collision'
  /** Never ran concurrently: no counterfactual. */
  | 'censored_held';

export const PAIR_OUTCOMES: readonly PairOutcome[] = [
  'clean_merge_tree', 'mergiraf_resolved', 'rebase_required', 'git_conflict',
  'ci_semantic_regression', 'human_intervention', 'migration_index_collision', 'censored_held',
];

/** Harm = the start cost real repair. Null = no observation. */
export function isHarmful(outcome: PairOutcome): boolean | null {
  switch (outcome) {
    case 'censored_held': return null;
    case 'clean_merge_tree':
    case 'mergiraf_resolved':
    case 'rebase_required': return false;
    default: return true;
  }
}

export interface ClaimRiskScenario {
  id: string;
  /** Frozen split: tune on `train`, report on `heldout`, re-check on `later`. */
  split: 'train' | 'heldout' | 'later';
  /** A short shape label for grouping (e.g. `stale_mission_refresh`). */
  shape: string;
  input: ClaimRiskInput;
  outcome: PairOutcome;
  /** Minutes the candidate waited (or would have) behind the holder. */
  waitMinutes?: number;
  /** Minutes of repair a harmful start cost. */
  repairMinutes?: number;
}

export type PolicyAction = 'START' | 'HOLD' | 'ASK';

export interface PolicyAnswer {
  action: PolicyAction;
  /** Optional probability of harm, for Brier and calibration bins. */
  pHarm?: number | null;
}

export type ClaimRiskPolicy = (s: ClaimRiskScenario) => PolicyAnswer;

/** Baseline: every overlap holds (the pre-split behaviour). */
export const holdAllPolicy: ClaimRiskPolicy = () => ({ action: 'HOLD' });
/** Baseline: every non-hard overlap starts (isolated worktrees, nothing else). */
export const startUnlessHardPolicy: ClaimRiskPolicy = (s) =>
  ({ action: assessClaimOverlapRisk(s.input).tier === 'hard' ? 'HOLD' : 'START' });

/**
 * The risk profile as shipped. `ask` is what to do where the profile defers to
 * the model: `HOLD` (the rule's fallback), or a replayed answer per scenario.
 */
export function riskProfilePolicy(ask: (s: ClaimRiskScenario, a: ClaimRiskAssessment) => PolicyAnswer = () => ({ action: 'HOLD' })): ClaimRiskPolicy {
  return (s) => {
    const a = assessClaimOverlapRisk(s.input);
    if (a.route === 'deterministic_start') return { action: 'START', pHarm: null };
    if (a.route === 'deterministic_hold') return { action: 'HOLD', pHarm: null };
    return ask(s, a);
  };
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  n: number;
  meanPredicted: number | null;
  observedRate: number | null;
}

export interface ClaimRiskEvaluation {
  scenarios: number;
  /** Pairs with an observed outcome (both ran). */
  observed: number;
  /** Pairs with no counterfactual: reported, never scored. */
  censored: number;
  /** Policy deferred to the model and no answer was supplied. */
  abstained: number;
  actions: Record<PolicyAction, number>;
  /** Observed pairs the policy started that turned out harmful. */
  unsafeStarts: number;
  /** unsafeStarts / observed starts; null with no observed start. */
  unsafeStartRate: number | null;
  /**
   * Observed pairs the policy would have held that ran harmlessly. Only pairs
   * that actually ran have this counterfactual; a censored hold is not here.
   */
  preventableHolds: number;
  preventableHoldRate: number | null;
  /** HOLD as a harm detector over observed pairs. */
  precision: number | null;
  recall: number | null;
  /** Outcome classes among observed pairs, kept apart. */
  byOutcome: Partial<Record<PairOutcome, number>>;
  byTier: Partial<Record<ClaimRiskTier, number>>;
  /** Wait spent on held pairs that ran harmlessly + repair on unsafe starts. */
  cost: { waitMinutes: number; repairMinutes: number; totalMinutes: number };
  /** Over observed pairs whose answer carried pHarm. */
  brier: number | null;
  calibration: CalibrationBin[];
}

const rate = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);

export function calibrationBins(pairs: Array<{ p: number; y: boolean }>, bins = 5): CalibrationBin[] {
  const out: CalibrationBin[] = [];
  for (let i = 0; i < bins; i++) {
    const lower = i / bins;
    const upper = (i + 1) / bins;
    const inBin = pairs.filter(x => x.p >= lower && (i === bins - 1 ? x.p <= upper : x.p < upper));
    out.push({
      lower, upper, n: inBin.length,
      meanPredicted: inBin.length ? Math.round((inBin.reduce((a, x) => a + x.p, 0) / inBin.length) * 1000) / 1000 : null,
      observedRate: rate(inBin.filter(x => x.y).length, inBin.length),
    });
  }
  return out;
}

export function evaluateClaimRiskPolicy(
  scenarios: readonly ClaimRiskScenario[],
  policy: ClaimRiskPolicy,
  opts: { split?: ClaimRiskScenario['split'] } = {},
): ClaimRiskEvaluation {
  const rows = opts.split ? scenarios.filter(s => s.split === opts.split) : [...scenarios];
  const actions: Record<PolicyAction, number> = { START: 0, HOLD: 0, ASK: 0 };
  const byOutcome: Partial<Record<PairOutcome, number>> = {};
  const byTier: Partial<Record<ClaimRiskTier, number>> = {};
  let observed = 0, censored = 0, abstained = 0;
  let unsafeStarts = 0, observedStarts = 0, preventableHolds = 0, observedHolds = 0;
  let tp = 0, fp = 0, fn = 0;
  let waitMinutes = 0, repairMinutes = 0;
  const probs: Array<{ p: number; y: boolean }> = [];

  for (const s of rows) {
    const tier = assessClaimOverlapRisk(s.input).tier;
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    const answer = policy(s);
    actions[answer.action]++;
    const harm = isHarmful(s.outcome);
    if (harm === null) { censored++; continue; }
    observed++;
    byOutcome[s.outcome] = (byOutcome[s.outcome] ?? 0) + 1;
    if (answer.action === 'ASK') { abstained++; continue; }
    if (typeof answer.pHarm === 'number' && Number.isFinite(answer.pHarm)) probs.push({ p: Math.min(1, Math.max(0, answer.pHarm)), y: harm });
    if (answer.action === 'START') {
      observedStarts++;
      if (harm) { unsafeStarts++; repairMinutes += s.repairMinutes ?? 0; }
    } else {
      observedHolds++;
      if (harm) tp++;
      else { fp++; preventableHolds++; waitMinutes += s.waitMinutes ?? 0; }
    }
    if (answer.action === 'START' && harm) fn++;
  }

  const brier = probs.length ? Math.round((probs.reduce((a, x) => a + (x.p - (x.y ? 1 : 0)) ** 2, 0) / probs.length) * 1000) / 1000 : null;
  return {
    scenarios: rows.length,
    observed,
    censored,
    abstained,
    actions,
    unsafeStarts,
    unsafeStartRate: rate(unsafeStarts, observedStarts),
    preventableHolds,
    preventableHoldRate: rate(preventableHolds, observedHolds),
    precision: rate(tp, tp + fp),
    recall: rate(tp, tp + fn),
    byOutcome,
    byTier,
    cost: { waitMinutes, repairMinutes, totalMinutes: waitMinutes + repairMinutes },
    brier,
    calibration: probs.length ? calibrationBins(probs) : [],
  };
}
