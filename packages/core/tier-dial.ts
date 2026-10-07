/**
 * The per-cell dial — the pure half.
 *
 * A cell is one tier x surface. Its pool's incumbent is the cell's primary and
 * its challengers are what the cell "may also use". One dial, 1..5, replaces
 * explicit weights and explore levels for normal use:
 *
 *   1 = always the primary          5 = the cheapest model that keeps up
 *
 * The dial sets two things: the tolerance (how far below the primary an
 * alternate's outcome rates may sit and still count as keeping up, and with
 * what confidence) and the most traffic an alternate may take once it does.
 *
 * States (`DialState`, rendered verbatim by the UI):
 *
 *   always   — dial 1 or no alternates. The primary serves everything.
 *   learning — shadow. The primary still serves every run. Each eligible run
 *              records which alternate would have been picked; the alternate
 *              is graded on the team's own coding outcomes (merged, first
 *              review ok, no rework) wherever the team ran it.
 *   shifted  — an alternate met the primary within tolerance after both had
 *              `threshold` graded runs. It takes the dial's share.
 *   reverted — the shifted alternate fell behind on the cell's own runs. Back
 *              to the primary, with the reason, for a cooldown; then learning
 *              restarts on evidence from after the revert only.
 *
 * Promotion and revert are deliberately asymmetric. Promotion reads
 * observational evidence (the alternate ran on other cells' work too, which
 * may be easier) so it needs a confidence bound: the lower bound of
 * (alternate − primary) must clear −margin on every graded signal. Revert
 * reads the cell's own randomized runs since the shift, which are a fair
 * comparison, and triggers on the point estimate alone — quick to undo,
 * slow to commit.
 *
 * The threshold (graded runs needed before a promotion is considered) is not
 * a constant. For the dial's margin m and confidence z, and the primary's
 * outcome variance v = p(1−p) on its noisiest signal, the runs each side
 * needs for a two-sample bound of half-width m when the rates are equal is
 *
 *     n = 2 · z² · v / m²
 *
 * A cell that accrues graded runs slowly would wait months for that, so when
 * n would take longer than `HORIZON_DAYS` at the cell's pace, z is lowered
 * (never below `Z_FLOOR`) to the value that fits; the same z is then used by
 * the promotion test, so the threshold is exactly the point at which equal
 * rates can pass. `MIN_THRESHOLD` keeps a tiny cell from deciding on a
 * handful of runs.
 *
 * No db, no clock, no env: everything comes in as arguments.
 */
import type { Allocation, PoolArmRef } from './tier-pool';

export type Dial = 1 | 2 | 3 | 4 | 5;
export const DEFAULT_DIAL: Dial = 3;

export function isDial(v: unknown): v is Dial {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5;
}

export interface DialSetting {
  /** How far below the primary (absolute rate) an alternate may be. */
  margin: number;
  /** One-sided z for the promotion bound. */
  z: number;
  /** The most of a cell's eligible runs a shifted alternate takes. */
  maxShare: number;
}

/** Dial 1 never learns, so its numbers are never read. */
export const DIAL_SETTINGS: Record<Dial, DialSetting> = {
  1: { margin: 0, z: 1.645, maxShare: 0 },
  2: { margin: 0.05, z: 1.645, maxShare: 0.25 },
  3: { margin: 0.08, z: 1.645, maxShare: 0.5 },
  4: { margin: 0.12, z: 1.282, maxShare: 0.75 },
  5: { margin: 0.15, z: 1.036, maxShare: 1 },
};

/** Never fewer graded runs than this per side. */
export const MIN_THRESHOLD = 20;
/** A threshold should be reachable within this many days at the cell's pace. */
export const HORIZON_DAYS = 28;
/** The least confidence a slow cell may trade down to (85% one-sided). */
export const Z_FLOOR = 1.036;
/** A signal needs this many graded runs on both sides to be compared at all. */
export const MIN_METRIC_N = 10;
/** In-cell graded runs on the alternate before a revert can trigger. */
export const REVERT_MIN_N = 12;
/** A reverted cell stays on the primary this long before learning again. */
export const REVERT_COOLDOWN_DAYS = 14;

const DAY_MS = 86_400_000;

// ── Evidence ────────────────────────────────────────────────────────────────

/** k successes out of n graded runs. */
export interface Rate { n: number; k: number }

/**
 * The three coding signals, each "higher is better":
 * - merged: the run's PR merged (a closed PR or a model-attributable failure is a miss)
 * - reviewOk: the first reviewer verdict was approve
 * - reworkFree: no reviewer asked for changes
 */
export interface OutcomeRates {
  merged: Rate;
  reviewOk: Rate;
  reworkFree: Rate;
}

export type OutcomeSignal = keyof OutcomeRates;
export const OUTCOME_SIGNALS: readonly OutcomeSignal[] = ['merged', 'reviewOk', 'reworkFree'];

export interface ModelEvidence {
  rates: OutcomeRates;
  costPerRunUsd: number | null;
}

export const EMPTY_RATES: OutcomeRates = { merged: { n: 0, k: 0 }, reviewOk: { n: 0, k: 0 }, reworkFree: { n: 0, k: 0 } };
export const EMPTY_MODEL_EVIDENCE: ModelEvidence = { rates: EMPTY_RATES, costPerRunUsd: null };

/** A run is "graded" once its merge outcome is known. */
export function gradedRuns(e: ModelEvidence | OutcomeRates): number {
  return ('rates' in e ? e.rates : e).merged.n;
}

/** Agresti-Caffo adjusted proportion: never 0 or 1, so a bound always has width. */
function adjusted(r: Rate): number {
  return (r.k + 1) / (r.n + 2);
}

function raw(r: Rate): number | null {
  return r.n > 0 ? r.k / r.n : null;
}

// ── Threshold ───────────────────────────────────────────────────────────────

export interface DialThreshold {
  threshold: number;
  /** The confidence the promotion test uses (the dial's, or lowered for pace). */
  z: number;
  /** Days to `threshold` at the cell's pace; null when the pace is unknown. */
  etaDays: number | null;
  /** `bound` = the dial's own confidence; `pace` = lowered to fit the horizon. */
  basis: 'bound' | 'pace';
}

function requiredRuns(z: number, v: number, m: number): number {
  return Math.max(MIN_THRESHOLD, Math.ceil((2 * z * z * v) / (m * m)));
}

/**
 * Graded runs each side needs before a promotion is considered. `primary` is
 * the cell's primary evidence (its variance sets the bound; unknown reads as
 * the worst case, p = 0.5). `gradedPerDay` is how fast the cell accrues graded
 * runs.
 */
export function dialThreshold(args: { dial: Dial; primary: OutcomeRates; gradedPerDay: number }): DialThreshold {
  const s = DIAL_SETTINGS[args.dial];
  const m = s.margin > 0 ? s.margin : DIAL_SETTINGS[DEFAULT_DIAL].margin;
  let v = 0;
  for (const sig of OUTCOME_SIGNALS) {
    const r = args.primary[sig];
    if (sig !== 'merged' && r.n < MIN_METRIC_N) continue;
    const p = r.n > 0 ? adjusted(r) : 0.5;
    v = Math.max(v, p * (1 - p));
  }
  if (v === 0) v = 0.25;

  const pace = Number.isFinite(args.gradedPerDay) && args.gradedPerDay > 0 ? args.gradedPerDay : 0;
  let z = s.z;
  let threshold = requiredRuns(z, v, m);
  let basis: DialThreshold['basis'] = 'bound';
  if (pace > 0 && threshold / pace > HORIZON_DAYS) {
    // Solve n = 2 z² v / m² for z at n = pace · horizon, floored.
    const reachable = pace * HORIZON_DAYS;
    const zFit = m * Math.sqrt(reachable / (2 * v));
    const zNew = Math.max(Z_FLOOR, Math.min(s.z, zFit));
    if (zNew < z) {
      z = zNew;
      threshold = requiredRuns(z, v, m);
      basis = 'pace';
    }
  }
  return { threshold, z, etaDays: pace > 0 ? Math.ceil(threshold / pace) : null, basis };
}

// ── Comparison ──────────────────────────────────────────────────────────────

export interface ToleranceCheck {
  ok: boolean;
  /** Signals compared (enough runs on both sides). */
  checked: OutcomeSignal[];
  /** Signals whose bound fell outside the margin. */
  failing: OutcomeSignal[];
}

/**
 * Non-inferiority on every signal with enough runs: the one-sided lower bound
 * of (alternate − primary) at `z` must be at least −margin. `merged` must be
 * compared; review signals are compared when both sides have
 * `MIN_METRIC_N` reviewed runs.
 */
export function withinTolerance(alt: OutcomeRates, primary: OutcomeRates, margin: number, z: number): ToleranceCheck {
  const checked: OutcomeSignal[] = [];
  const failing: OutcomeSignal[] = [];
  for (const sig of OUTCOME_SIGNALS) {
    const a = alt[sig];
    const p = primary[sig];
    if (a.n < MIN_METRIC_N || p.n < MIN_METRIC_N) continue;
    checked.push(sig);
    const pa = adjusted(a);
    const pp = adjusted(p);
    const se = Math.sqrt((pa * (1 - pa)) / (a.n + 2) + (pp * (1 - pp)) / (p.n + 2));
    if (pa - pp - z * se < -margin) failing.push(sig);
  }
  return { ok: checked.includes('merged') && failing.length === 0, checked, failing };
}

const SIGNAL_LABEL: Record<OutcomeSignal, string> = {
  merged: 'merged',
  reviewOk: 'review ok',
  reworkFree: 'no rework',
};

/** The revert test: any signal's point estimate below the comparator by more than the margin. */
function slipped(alt: OutcomeRates, comparator: OutcomeRates, margin: number): string | null {
  for (const sig of OUTCOME_SIGNALS) {
    const a = alt[sig];
    const c = comparator[sig];
    if (a.n < REVERT_MIN_N || c.n < MIN_METRIC_N) continue;
    const ra = raw(a)!;
    const rc = raw(c)!;
    if (ra < rc - margin) {
      return `${SIGNAL_LABEL[sig]} rate ${pct(ra)} vs primary ${pct(rc)} over ${a.n} runs (tolerance ${Math.round(margin * 100)} points)`;
    }
  }
  return null;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

// ── State machine ───────────────────────────────────────────────────────────

export type DialState = 'always' | 'learning' | 'shifted' | 'reverted';

/** Persisted on the pool (`tier_pools.dial_state`). */
export interface DialStateRecord {
  state: DialState;
  /** When the cell entered `state` (ISO). */
  since: string;
  /** `shifted`: the alternate taking the share. */
  alternateArmId?: string | null;
  /** `reverted`: why, in plain words. Kept after the cell moves on. */
  revertReason?: string;
  revertedAt?: string;
  /** Learning only counts evidence from this time on (set after a revert). */
  evidenceSince?: string;
  /** `learning`: the alternate the shadow records as its pick (the cheapest). */
  candidateArmId?: string | null;
  /** When the daily step last evaluated the cell (ISO). */
  evaluatedAt?: string;
}

export interface DialAlternateInput {
  armId: string;
  model: string;
  /** The team's graded coding runs on this model (since `evidenceSince`). */
  evidence: ModelEvidence;
  /** This cell's own runs served by this alternate since it shifted. */
  inCell: ModelEvidence;
}

export interface DialCellInput {
  dial: Dial;
  prior: DialStateRecord | null;
  now: Date;
  /** The cell's primary and its graded runs in this cell. */
  primary: { armId: string; evidence: ModelEvidence };
  /** Active alternates, in pool order. */
  alternates: DialAlternateInput[];
  /** The primary's runs in this cell since the shift (the fair comparator for revert). */
  primaryInCellSinceShift: ModelEvidence;
  /** Graded runs per day the cell accrues. */
  gradedPerDay: number;
}

export interface DialProgress {
  graded: number;
  threshold: number;
  primaryGraded: number;
  candidate: string | null;
  etaDays: number | null;
  note?: string;
}

export interface DialEvent {
  kind: 'promotion' | 'revert' | 'dial';
  reason: string;
  evidence: Record<string, unknown>;
}

export interface DialDecision {
  record: DialStateRecord;
  /** Share of eligible runs on `alternateArmId` (0 unless shifted). */
  share: number;
  alternateArmId: string | null;
  progress?: DialProgress;
  /** Set whenever the state changed. Every change is recorded. */
  event?: DialEvent;
}

/** Cheapest known cost first; unknown cost last; pool order breaks ties. */
function byCost(alts: readonly DialAlternateInput[]): DialAlternateInput[] {
  return alts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const cx = x.a.evidence.costPerRunUsd;
      const cy = y.a.evidence.costPerRunUsd;
      if (cx == null && cy != null) return 1;
      if (cy == null && cx != null) return -1;
      return (cx ?? 0) - (cy ?? 0) || x.i - y.i;
    })
    .map(x => x.a);
}

/** The alternate the shadow would pick right now. */
export function shadowCandidate(alts: readonly DialAlternateInput[]): DialAlternateInput | null {
  return byCost(alts)[0] ?? null;
}

/**
 * One evaluation of a cell. At most one transition per call: a cell that just
 * started learning (or came out of a revert cooldown) is judged on the next
 * call, so every recorded event names a single, explainable step.
 */
export function decideDialCell(input: DialCellInput): DialDecision {
  const nowIso = input.now.toISOString();
  const prior = input.prior;
  const s = DIAL_SETTINGS[input.dial];

  if (input.dial === 1 || input.alternates.length === 0) {
    const record: DialStateRecord = { ...keep(prior), state: 'always', since: prior?.state === 'always' ? prior.since : nowIso };
    const decision: DialDecision = { record, share: 0, alternateArmId: null };
    if (prior && prior.state !== 'always') {
      decision.event = {
        kind: 'dial',
        reason: input.dial === 1 ? 'dial set to always use the primary' : 'no alternates left in the cell',
        evidence: { from: prior.state, alternateArmId: prior.alternateArmId ?? null },
      };
    }
    return decision;
  }

  if (!prior || prior.state === 'always') {
    return {
      record: { ...keep(prior), state: 'learning', since: nowIso },
      share: 0,
      alternateArmId: null,
      progress: progressFor(input, null),
      event: { kind: 'dial', reason: 'learning started: the primary keeps serving while alternates are graded', evidence: { dial: input.dial } },
    };
  }

  if (prior.state === 'shifted') {
    const alt = input.alternates.find(a => a.armId === prior.alternateArmId);
    if (!alt) {
      return {
        record: { ...keep(prior), state: 'learning', since: nowIso, alternateArmId: null },
        share: 0,
        alternateArmId: null,
        progress: progressFor(input, null),
        event: { kind: 'dial', reason: 'the shifted alternate left the cell; back to the primary', evidence: { alternateArmId: prior.alternateArmId ?? null } },
      };
    }
    const comparator = gradedRuns(input.primaryInCellSinceShift) >= MIN_METRIC_N
      ? input.primaryInCellSinceShift.rates
      : input.primary.evidence.rates;
    const reason = slipped(alt.inCell.rates, comparator, s.margin);
    if (reason) {
      return {
        record: { state: 'reverted', since: nowIso, alternateArmId: null, revertReason: reason, revertedAt: nowIso, evidenceSince: nowIso },
        share: 0,
        alternateArmId: null,
        event: {
          kind: 'revert',
          reason,
          evidence: { alternateArmId: alt.armId, model: alt.model, dial: input.dial, alternate: alt.inCell.rates, primary: comparator },
        },
      };
    }
    return { record: prior, share: s.maxShare, alternateArmId: alt.armId };
  }

  if (prior.state === 'reverted') {
    const at = Date.parse(prior.revertedAt ?? prior.since);
    if (Number.isFinite(at) && input.now.getTime() - at < REVERT_COOLDOWN_DAYS * DAY_MS) {
      return { record: prior, share: 0, alternateArmId: null };
    }
    return {
      record: { ...keep(prior), state: 'learning', since: nowIso, evidenceSince: prior.revertedAt ?? prior.since },
      share: 0,
      alternateArmId: null,
      progress: progressFor(input, null),
      event: { kind: 'dial', reason: 'revert cooldown over: learning again on runs since the revert', evidence: { revertedAt: prior.revertedAt ?? null } },
    };
  }

  // learning
  const t = dialThreshold({ dial: input.dial, primary: input.primary.evidence.rates, gradedPerDay: input.gradedPerDay });
  const primaryGraded = gradedRuns(input.primary.evidence);
  let anyReady = false;
  for (const alt of byCost(input.alternates)) {
    if (gradedRuns(alt.evidence) < t.threshold || primaryGraded < t.threshold) continue;
    anyReady = true;
    const check = withinTolerance(alt.evidence.rates, input.primary.evidence.rates, s.margin, t.z);
    if (!check.ok) continue;
    return {
      record: { ...keep(prior), state: 'shifted', since: nowIso, alternateArmId: alt.armId },
      share: s.maxShare,
      alternateArmId: alt.armId,
      event: {
        kind: 'promotion',
        reason: `${alt.model} kept up with the primary on ${check.checked.map(c => SIGNAL_LABEL[c]).join(', ')} over ${gradedRuns(alt.evidence)} graded runs`,
        evidence: {
          alternateArmId: alt.armId, model: alt.model, dial: input.dial, share: s.maxShare,
          threshold: t.threshold, z: t.z, margin: s.margin, basis: t.basis,
          alternate: alt.evidence.rates, primary: input.primary.evidence.rates,
        },
      },
    };
  }
  return {
    record: prior,
    share: 0,
    alternateArmId: null,
    progress: progressFor(input, t, anyReady ? 'enough runs, but outcomes are not yet within tolerance of the primary' : undefined),
  };
}

/** Fields that survive a transition: the last revert reason stays for history. */
function keep(prior: DialStateRecord | null): Partial<DialStateRecord> {
  if (!prior) return {};
  return {
    ...(prior.revertReason ? { revertReason: prior.revertReason } : {}),
    ...(prior.revertedAt ? { revertedAt: prior.revertedAt } : {}),
    ...(prior.evidenceSince ? { evidenceSince: prior.evidenceSince } : {}),
  };
}

/** Where a learning cell stands: the shadow's candidate against the threshold. */
export function learningProgress(input: DialCellInput): DialProgress {
  return progressFor(input, null);
}

function progressFor(input: DialCellInput, t: DialThreshold | null, note?: string): DialProgress {
  const th = t ?? dialThreshold({ dial: input.dial, primary: input.primary.evidence.rates, gradedPerDay: input.gradedPerDay });
  const cand = shadowCandidate(input.alternates);
  const graded = cand ? gradedRuns(cand.evidence) : 0;
  const remaining = Math.max(0, th.threshold - Math.min(graded, gradedRuns(input.primary.evidence)));
  return {
    graded,
    threshold: th.threshold,
    primaryGraded: gradedRuns(input.primary.evidence),
    candidate: cand?.armId ?? null,
    etaDays: input.gradedPerDay > 0 ? Math.ceil(remaining / input.gradedPerDay) : null,
    ...(note ? { note } : {}),
  };
}

// ── Serving ─────────────────────────────────────────────────────────────────

/** The allocation a dial pool serves: all primary unless shifted. */
export function dialAllocation(arms: readonly PoolArmRef[], record: DialStateRecord | null, dial: Dial): Allocation {
  const out: Allocation = {};
  const active = arms.filter(a => a.status === 'active');
  const incumbent = active.find(a => a.role === 'incumbent');
  for (const a of active) out[a.id] = 0;
  if (!incumbent) return out;
  const share = record?.state === 'shifted' && dial !== 1 ? DIAL_SETTINGS[dial].maxShare : 0;
  const alt = share > 0 ? active.find(a => a.id === record?.alternateArmId && a.role === 'challenger') : undefined;
  if (!alt) {
    out[incumbent.id] = 1;
    return out;
  }
  out[alt.id] = share;
  out[incumbent.id] = Math.round((1 - share) * 10_000) / 10_000;
  return out;
}

/**
 * Which arm a dial pool serves for one run. Only a shifted cell ever serves an
 * alternate, and only the alternate it shifted to; everything else (a sticky
 * prior on another arm, a stale allocation) serves the primary. In learning,
 * `shadowArmId` is what would have been picked, recorded with the run.
 */
export function decideDialArm(args: {
  record: DialStateRecord | null;
  incumbentId: string;
  drawnArmId: string | null;
  shadowArmId: string | null;
}): { armId: string; shadowArmId: string | null } {
  const r = args.record;
  if (r?.state === 'shifted' && args.drawnArmId && (args.drawnArmId === r.alternateArmId || args.drawnArmId === args.incumbentId)) {
    return { armId: args.drawnArmId, shadowArmId: null };
  }
  return { armId: args.incumbentId, shadowArmId: r?.state === 'learning' ? args.shadowArmId : null };
}

/** The state a cell shows: `always` whenever dial is 1 or nothing else is allowed. */
export function cellState(record: DialStateRecord | null, dial: Dial, alternates: number): DialState {
  if (dial === 1 || alternates === 0) return 'always';
  return record?.state ?? 'learning';
}

// ── Grading the team's own coding runs ──────────────────────────────────────

/** One finished coding run, as loaded from tasks, task_outcomes, workers and reviewer tasks. */
export interface CodingRun {
  taskId: string;
  at: Date;
  tier: string | null;
  model: string | null;
  outcome: string | null;
  exitCause: string | null;
  costUsd: number | null;
  /** Any of the task's workers' PRs merged. */
  merged: boolean;
  /** A PR was closed without merging. */
  prClosed: boolean;
  /** Reviewer verdicts on this run, oldest first (`approve` | `request-changes` | `escalate`). */
  verdicts: string[];
}

export interface RunGrade {
  merged: boolean | null;
  reviewOk: boolean | null;
  reworkFree: boolean | null;
}

/**
 * A run's grade on each signal, or null where the signal is not known yet.
 * Merged is known once the PR merged or closed, or the run failed for a
 * model-attributable reason (an infrastructure failure says nothing about
 * the model, so it stays ungraded).
 */
export function gradeRun(run: CodingRun, infraExitCauses: ReadonlySet<string>): RunGrade {
  let merged: boolean | null = null;
  if (run.merged) merged = true;
  else if (run.prClosed) merged = false;
  else if (run.outcome === 'failed' && !(run.exitCause && infraExitCauses.has(run.exitCause))) merged = false;
  const v = run.verdicts.filter(x => x === 'approve' || x === 'request-changes' || x === 'escalate');
  return {
    merged,
    reviewOk: v.length ? v[0] === 'approve' : null,
    reworkFree: v.length ? !v.includes('request-changes') : null,
  };
}

/** Evidence for a set of runs. */
export function evidenceFrom(runs: readonly CodingRun[], infraExitCauses: ReadonlySet<string>): ModelEvidence {
  const rates: OutcomeRates = { merged: { n: 0, k: 0 }, reviewOk: { n: 0, k: 0 }, reworkFree: { n: 0, k: 0 } };
  let cost = 0;
  let costN = 0;
  for (const r of runs) {
    const g = gradeRun(r, infraExitCauses);
    for (const sig of OUTCOME_SIGNALS) {
      const val = g[sig];
      if (val === null) continue;
      rates[sig].n += 1;
      if (val) rates[sig].k += 1;
    }
    if (r.costUsd != null && Number.isFinite(r.costUsd)) { cost += r.costUsd; costN += 1; }
  }
  return { rates, costPerRunUsd: costN ? cost / costN : null };
}

/** Graded runs per day over `windowDays` (merged known). */
export function gradedPace(runs: readonly CodingRun[], infraExitCauses: ReadonlySet<string>, windowDays: number): number {
  if (windowDays <= 0) return 0;
  const graded = runs.filter(r => gradeRun(r, infraExitCauses).merged !== null).length;
  return graded / windowDays;
}

// ── An admin turning the dial ───────────────────────────────────────────────

/**
 * The state after an admin sets the dial. Dial 1 stops any shift at once;
 * turning a cell up from `always` (or putting a pool under the dial for the
 * first time) starts learning. Anything else keeps its state: the new dial
 * only changes the tolerance and the share, which the allocation picks up.
 * Every state change carries an event for the change log.
 */
export function applyDialChange(args: {
  prior: DialStateRecord | null;
  dial: Dial;
  alternates: number;
  now: Date;
}): { record: DialStateRecord; event?: DialEvent } {
  const nowIso = args.now.toISOString();
  const { prior, dial } = args;
  if (dial === 1 || args.alternates === 0) {
    const record: DialStateRecord = { ...keep(prior), state: 'always', since: prior?.state === 'always' ? prior.since : nowIso };
    if (prior?.state === 'always') return { record };
    return {
      record,
      event: {
        kind: 'dial',
        reason: dial === 1 ? 'dial set to always use the primary' : 'no alternates in the cell',
        evidence: { from: prior?.state ?? null, dial },
      },
    };
  }
  if (!prior || prior.state === 'always') {
    return {
      record: { ...keep(prior), state: 'learning', since: nowIso },
      event: { kind: 'dial', reason: 'learning started: the primary keeps serving while alternates are graded', evidence: { dial } },
    };
  }
  return { record: prior };
}
