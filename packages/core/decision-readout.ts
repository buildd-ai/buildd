/**
 * The shared decision readout: one window of one decision kind's ledger rows,
 * outcome labels and challenger runs, summarized the same way for every kind.
 *
 * Pure: the rows come from `decision-readout-source.ts`. Two rules shape it.
 *
 * 1. **Not collecting is not "insufficient sample".** Earlier decision shadows
 *    shipped and wrote zero rows for weeks because a team switch was never
 *    flipped, and a readout that said "n too small" hid it. `collection.state`
 *    answers whether the kind is collecting at all before it says anything
 *    about sample size:
 *      - `disabled`: the team's capability switch is off;
 *      - `misconfigured`: on, but no key / every call unavailable;
 *      - `not_collecting`: on, but no rows, or no model answers (every call
 *        failed, or only rules decided);
 *      - `insufficient_sample`: collecting, labelled outcomes below the minimum;
 *      - `sufficient`.
 *
 * 2. **No causal lift without randomized assignment.** Everything grouped by
 *    policy or provider here is observational: those rows were not assigned at
 *    random, so a difference between groups is not an effect. `causal` claims
 *    a difference only for rows stamped with an `assignExperimentArm`
 *    assignment (`experiment-randomizer.ts`), one experiment at a time.
 *
 * Quality is the kind's, never this module's: an `objective` adapter says
 * whether an answer was right given an outcome label. Without one, labels are
 * counted and nothing is scored.
 */

import { newcombeInterval, wilsonInterval, type Interval, type ReadoutVerdict } from './experiment-readout';

export interface ReadoutDecisionRow {
  id: string;
  status: 'applied' | 'suggested' | 'fallback';
  applied: boolean;
  appliedAnswer: string | null;
  policyVersion: string | null;
  provider: string | null;
  model: string | null;
  attemptCount: number | null;
  escalated: boolean;
  failureClass: 'capability' | 'key' | 'provider' | null;
  subjectType: string | null;
  subjectId: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  experimentId: string | null;
  experimentArm: string | null;
}

export interface ReadoutOutcomeRow {
  decisionRecordId: string;
  source: string;
  label: string;
  value: number | null;
}

export interface ReadoutChallengerRow {
  decisionRecordId: string;
  challengerKey: string;
  status: 'attempted' | 'skipped';
  skipReason: string | null;
  provider: string | null;
  model: string | null;
  outcome: string | null;
  decision: string | null;
  agrees: boolean | null;
  failureKind: string | null;
  latencyMs: number | null;
  costUsd: number | null;
}

export interface ReadoutRows {
  records: ReadoutDecisionRow[];
  outcomes: ReadoutOutcomeRow[];
  challengers: ReadoutChallengerRow[];
  /** The source hit its row cap: counts are a floor. */
  truncated?: boolean;
  /** The kind binds a challenger, so a decision with no challenger row is a gap (`notRun`). */
  challengerConfigured?: boolean;
}

/** What the team's settings say, read without spending (`resolveDecisionAccess`). */
export interface CollectionConfig {
  access: 'enabled' | 'capability_disabled' | 'missing_key' | 'unknown';
  /** Subjects the kind could have decided in the window, from the kind's adapter. Null: unknown. */
  eligibleSubjects: number | null;
}

/** The kind's definition of right. The only quality logic a readout runs. */
export interface DecisionObjective {
  /** Which labelling source to score. Default: any (the first label per record). */
  source?: string;
  /** Was `answer` right, given this outcome? Null: the outcome does not say. */
  score(outcome: { label: string; value: number | null }, answer: string): boolean | null;
}

/**
 * A kind's readout adapter, carried on its binding. Everything a readout
 * needs to know about a kind and cannot read off the ledger.
 */
export interface DecisionReadoutAdapter {
  /** Subjects the kind could have decided in the window. Null: unknown. May query. */
  eligibleSubjects?: (window: { teamId: string; workspaceId: string | null; since: Date; until: Date }) => Promise<number | null>;
  objective?: DecisionObjective;
  /** Default 30. */
  minLabelled?: number;
}

export interface ReadoutOptions {
  /** Labelled outcomes needed before the readout is `sufficient` (and per arm, for a causal verdict). */
  minLabelled: number;
  objective?: DecisionObjective;
}

export type CollectionState = 'disabled' | 'misconfigured' | 'not_collecting' | 'insufficient_sample' | 'sufficient';

export interface Percentiles { p50: number | null; p90: number | null; max: number | null }

export interface ReadoutGroup {
  policyVersion: string | null;
  provider: string | null;
  model: string | null;
  n: number;
  applied: number;
  labelled: number;
  /** Labelled records the objective could score. */
  scored: number;
  correct: number;
  correctRate: number | null;
  interval: Interval;
}

export type CausalReadout =
  | { claim: false; reason: 'no_randomized_assignment' | 'mixed_experiments' | 'single_arm' | 'unrecognized_arms' | 'no_objective' }
  | {
      claim: true;
      experimentId: string;
      /** Rows in the window with no assignment: excluded, never pooled into an arm. */
      excludedUnassigned: number;
      arms: Array<{ arm: string; n: number; correct: number; rate: number | null }>;
      /** treatment − control correct rate (Newcombe). */
      difference: Interval & { difference: number };
      verdict: ReadoutVerdict;
    };

export interface DecisionReadout {
  collection: { state: CollectionState; collecting: boolean; reasons: string[] };
  eligibleSubjects: number | null;
  decidedSubjects: number;
  /** decidedSubjects / eligibleSubjects; null when eligibility is unknown or zero. */
  coverage: number | null;
  records: number;
  appliedAttempts: number;
  byStatus: { applied: number; suggested: number; fallback: number };
  failures: { capability: number; key: number; provider: number };
  escalation: { eligible: number; escalated: number; rate: number | null };
  latencyMs: Percentiles;
  cost: { totalUsd: number; perDecisionUsd: number | null };
  outcomes: { labelled: number; unlabelled: number; bySource: Record<string, number> };
  /** Observational: grouped, not randomized. */
  groups: ReadoutGroup[];
  challenger: {
    attempted: number;
    skipped: Record<string, number>;
    /** Decisions with no challenger row although the kind binds one. */
    notRun: number;
    failures: Record<string, number>;
    agreement: { n: number; agree: number; rate: number | null; interval: Interval };
    /** Applied vs challenger answers scored against the same outcome. */
    scored: { n: number; appliedCorrect: number; challengerCorrect: number };
    latencyMs: Percentiles;
    costUsd: number;
  };
  causal: CausalReadout;
}

/** Nearest-rank percentiles. */
export function percentiles(values: Array<number | null | undefined>): Percentiles {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { p50: null, p90: null, max: null };
  const at = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
  return { p50: at(0.5), p90: at(0.9), max: v[v.length - 1] };
}

const sum = (xs: Array<number | null | undefined>) => xs.reduce<number>((s, x) => s + (typeof x === 'number' && Number.isFinite(x) ? x : 0), 0);
const rate = (k: number, n: number) => (n > 0 ? k / n : null);

function collectionHealth(rows: ReadoutRows, config: CollectionConfig, labelled: number, opts: ReadoutOptions): DecisionReadout['collection'] {
  const extra = rows.truncated ? ['rows_truncated'] : [];
  const notCollecting = (state: CollectionState, reason: string) => ({ state, collecting: false, reasons: [reason, ...extra] });
  if (config.access === 'capability_disabled') return notCollecting('disabled', 'capability_disabled');
  if (config.access === 'missing_key') return notCollecting('misconfigured', 'missing_key');

  const records = rows.records;
  if (records.length === 0) return notCollecting('not_collecting', config.eligibleSubjects === 0 ? 'no_eligible_subjects' : 'no_records');
  const answered = records.filter(r => (r.attemptCount ?? 0) > 0 && r.failureClass !== 'provider').length;
  if (answered === 0) {
    if (records.some(r => r.failureClass === 'key' || r.failureClass === 'capability')) return notCollecting('misconfigured', 'every_call_unavailable');
    if (records.some(r => r.failureClass === 'provider')) return notCollecting('not_collecting', 'every_call_failed');
    return notCollecting('not_collecting', 'rules_only');
  }
  if (labelled < opts.minLabelled) {
    return { state: 'insufficient_sample', collecting: true, reasons: [`labelled ${labelled} < ${opts.minLabelled}`, ...extra] };
  }
  return { state: 'sufficient', collecting: true, reasons: extra };
}

export function computeDecisionReadout(rows: ReadoutRows, config: CollectionConfig, opts: ReadoutOptions): DecisionReadout {
  const { records, challengers } = rows;
  const objective = opts.objective;

  // The outcome each record is scored on: the objective's source, else the first label.
  const bySource: Record<string, number> = {};
  const outcomeOf = new Map<string, ReadoutOutcomeRow>();
  for (const o of rows.outcomes) {
    bySource[o.source] = (bySource[o.source] ?? 0) + 1;
    if (objective?.source && o.source !== objective.source) continue;
    if (!outcomeOf.has(o.decisionRecordId)) outcomeOf.set(o.decisionRecordId, o);
  }
  const recordIds = new Set(records.map(r => r.id));
  const labelled = [...outcomeOf.keys()].filter(id => recordIds.has(id)).length;
  const scoreOf = (r: { id: string }, answer: string | null): boolean | null => {
    const o = outcomeOf.get(r.id);
    if (!o || !objective || answer === null) return null;
    try {
      return objective.score({ label: o.label, value: o.value }, answer);
    } catch {
      return null;
    }
  };

  // Groups: policy version × provider × model. Observational.
  const groupMap = new Map<string, ReadoutGroup>();
  for (const r of records) {
    const key = `${r.policyVersion ?? ''}\u0000${r.provider ?? ''}\u0000${r.model ?? ''}`;
    let g = groupMap.get(key);
    if (!g) {
      g = { policyVersion: r.policyVersion, provider: r.provider, model: r.model, n: 0, applied: 0, labelled: 0, scored: 0, correct: 0, correctRate: null, interval: wilsonInterval(0, 0) };
      groupMap.set(key, g);
    }
    g.n++;
    if (r.applied) g.applied++;
    if (outcomeOf.has(r.id)) g.labelled++;
    const s = scoreOf(r, r.appliedAnswer);
    if (s !== null) {
      g.scored++;
      if (s) g.correct++;
    }
  }
  const groups = [...groupMap.values()]
    .map(g => ({ ...g, correctRate: rate(g.correct, g.scored), interval: wilsonInterval(g.correct, g.scored) }))
    .sort((a, b) => `${a.policyVersion}\u0000${a.provider}\u0000${a.model}`.localeCompare(`${b.policyVersion}\u0000${b.provider}\u0000${b.model}`));

  // Challengers.
  const attempted = challengers.filter(c => c.status === 'attempted');
  const skipped: Record<string, number> = {};
  for (const c of challengers) if (c.status === 'skipped') skipped[c.skipReason ?? 'unknown'] = (skipped[c.skipReason ?? 'unknown'] ?? 0) + 1;
  const failures: Record<string, number> = {};
  for (const c of attempted) if (c.failureKind) failures[c.failureKind] = (failures[c.failureKind] ?? 0) + 1;
  const compared = attempted.filter(c => c.agrees !== null);
  const agree = compared.filter(c => c.agrees).length;
  const withRun = new Set(challengers.map(c => c.decisionRecordId));
  const recordById = new Map(records.map(r => [r.id, r]));
  let scoredN = 0;
  let appliedCorrect = 0;
  let challengerCorrect = 0;
  for (const c of attempted) {
    const r = recordById.get(c.decisionRecordId);
    if (!r || c.decision === null) continue;
    const a = scoreOf(r, r.appliedAnswer);
    const b = scoreOf(r, c.decision);
    if (a === null || b === null) continue;
    scoredN++;
    if (a) appliedCorrect++;
    if (b) challengerCorrect++;
  }

  const subjects = new Set(records.filter(r => r.subjectId).map(r => `${r.subjectType ?? ''}:${r.subjectId}`));
  const modelAsked = records.filter(r => (r.attemptCount ?? 0) > 0);
  const totalUsd = sum(records.map(r => r.costUsd));

  return {
    collection: collectionHealth(rows, config, labelled, opts),
    eligibleSubjects: config.eligibleSubjects,
    decidedSubjects: subjects.size,
    coverage: config.eligibleSubjects ? subjects.size / config.eligibleSubjects : null,
    records: records.length,
    appliedAttempts: records.filter(r => r.applied).length,
    byStatus: {
      applied: records.filter(r => r.status === 'applied').length,
      suggested: records.filter(r => r.status === 'suggested').length,
      fallback: records.filter(r => r.status === 'fallback').length,
    },
    failures: {
      capability: records.filter(r => r.failureClass === 'capability').length,
      key: records.filter(r => r.failureClass === 'key').length,
      provider: records.filter(r => r.failureClass === 'provider').length,
    },
    escalation: {
      eligible: modelAsked.length,
      escalated: modelAsked.filter(r => r.escalated).length,
      rate: rate(modelAsked.filter(r => r.escalated).length, modelAsked.length),
    },
    latencyMs: percentiles(records.map(r => r.latencyMs)),
    cost: { totalUsd, perDecisionUsd: records.length ? totalUsd / records.length : null },
    outcomes: { labelled, unlabelled: records.length - labelled, bySource },
    groups,
    challenger: {
      attempted: attempted.length,
      skipped,
      notRun: rows.challengerConfigured ? records.filter(r => !withRun.has(r.id)).length : 0,
      failures,
      agreement: { n: compared.length, agree, rate: rate(agree, compared.length), interval: wilsonInterval(agree, compared.length) },
      scored: { n: scoredN, appliedCorrect, challengerCorrect },
      latencyMs: percentiles(attempted.map(c => c.latencyMs)),
      costUsd: sum(attempted.map(c => c.costUsd)),
    },
    causal: causalReadout(records, scoreOf, objective, opts.minLabelled),
  };
}

function causalReadout(
  records: ReadoutDecisionRow[],
  scoreOf: (r: { id: string }, answer: string | null) => boolean | null,
  objective: DecisionObjective | undefined,
  minPerArm: number,
): CausalReadout {
  const assigned = records.filter(r => r.experimentId && r.experimentArm);
  if (!assigned.length) return { claim: false, reason: 'no_randomized_assignment' };
  const experiments = new Set(assigned.map(r => r.experimentId));
  if (experiments.size > 1) return { claim: false, reason: 'mixed_experiments' };
  const armNames = [...new Set(assigned.map(r => r.experimentArm as string))].sort();
  if (armNames.length < 2) return { claim: false, reason: 'single_arm' };
  if (!objective) return { claim: false, reason: 'no_objective' };
  if (armNames.length !== 2 || !armNames.includes('control') || !armNames.includes('treatment')) return { claim: false, reason: 'unrecognized_arms' };

  const arms = armNames.map(arm => {
    let n = 0;
    let correct = 0;
    for (const r of assigned) {
      if (r.experimentArm !== arm) continue;
      const s = scoreOf(r, r.appliedAnswer);
      if (s === null) continue;
      n++;
      if (s) correct++;
    }
    return { arm, n, correct, rate: rate(correct, n) };
  });
  const control = arms.find(a => a.arm === 'control')!;
  const treatment = arms.find(a => a.arm === 'treatment')!;
  const difference = newcombeInterval(treatment.correct, treatment.n, control.correct, control.n);
  const verdict: ReadoutVerdict = control.n < minPerArm || treatment.n < minPerArm ? 'insufficient_n'
    : difference.lower > 0 ? 'treatment_better'
    : difference.upper < 0 ? 'treatment_worse'
    : 'no_detectable_difference';
  return {
    claim: true,
    experimentId: assigned[0].experimentId as string,
    excludedUnassigned: records.length - assigned.length,
    arms,
    difference,
    verdict,
  };
}
