/** Claim coordination adapts the existing model-policy dial, including its cooldown and events. */
import { wilsonInterval } from './experiment-readout';
import { decideDialCell, DIAL_SETTINGS, type Dial, type DialDecision, type DialStateRecord, type ModelEvidence } from './tier-dial';

export interface ClaimLearningOutcome {
  actor: 'jev_start' | 'jev_hold' | 'deterministic_hold' | 'human_force' | 'rule_start_clean' | 'rule_start_overlap';
  taskId?: string;
  confidence?: number;
  attributableUnsafe: boolean | null;
  staleBlocker?: boolean;
  matchedJevLabel?: 'HOLD' | 'START';
  waitMs?: number | null;
  idleMs?: number | null;
}

export interface ClaimLearningPolicy {
  delta: number;
  minSamplePerArm?: number;
  minConfidence: number;
  fraction: number;
  dial: Dial;
  record: DialStateRecord;
  pinned?: boolean;
}

export interface ClaimLearningCellInput {
  gate: string;
  area: string;
  fingerprint: string;
  outcomes: readonly ClaimLearningOutcome[];
  /** Matched, clean deterministic/control outcomes for this exact cell and fingerprint. */
  baseline: readonly ClaimLearningOutcome[];
  controlOutcomes?: readonly ClaimLearningOutcome[];
  prior?: ClaimLearningPolicy | null;
  now: Date;
  minSamplePerArm?: number;
}
const clean = (r: ClaimLearningOutcome) => !r.staleBlocker && r.attributableUnsafe !== null;
const control = (r: ClaimLearningOutcome) => clean(r) && r.actor === 'rule_start_clean';

/** Repeated polls are one task, and a later harm must never disappear behind a safe poll. */
function unique(rows: readonly ClaimLearningOutcome[]): ClaimLearningOutcome[] {
  const grouped = new Map<string, ClaimLearningOutcome>();
  rows.forEach((row, index) => {
    const key = row.taskId ?? `unkeyed:${index}`;
    const prior = grouped.get(key);
    if (!prior) { grouped.set(key, row); return; }
    const unsafe = prior.attributableUnsafe === true || row.attributableUnsafe === true
      ? true : prior.attributableUnsafe === null || row.attributableUnsafe === null ? null : false;
    const confidences = [prior.confidence, row.confidence].filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    grouped.set(key, { ...prior, attributableUnsafe: unsafe,
      confidence: confidences.length ? (unsafe ? Math.max(...confidences) : Math.min(...confidences)) : undefined });
  });
  return [...grouped.values()];
}

const treatment = (r: ClaimLearningOutcome) => clean(r) && r.actor === 'jev_start';
const rate = (rows: readonly ClaimLearningOutcome[]) => rows.length ? rows.filter(r => r.attributableUnsafe).length / rows.length : null;
/** Wilson upper endpoint of the two-sided 95% interval. */
export function claimUnsafeUpper95(unsafe: number, n: number): number | null {
  if (!n) {
    return null;
  }
  return wilsonInterval(unsafe, n).upper;
}

export function calibrateClaimConfidence(outcomes: readonly ClaimLearningOutcome[], baseline: readonly ClaimLearningOutcome[], delta = .05, minSamplePerArm = 20): number {
  const base = unique(baseline.filter(control));
  if (base.length < minSamplePerArm) {
    return .85;
  }
  const rows = unique(outcomes.filter(treatment)).filter(r => typeof r.confidence === 'number' && Number.isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 1);
  for (const threshold of [...new Set(rows.map(r => r.confidence!))].sort((a, b) => a - b)) {
    const selected = rows.filter(r => r.confidence! >= threshold);
    if (selected.length >= minSamplePerArm && claimUnsafeUpper95(selected.filter(r => r.attributableUnsafe).length, selected.length)! <= rate(base)! + delta) {
      return threshold;
    }
  }
  return .85;
}

function evidence(rows: readonly ClaimLearningOutcome[]): ModelEvidence {
  const r = {
    n: rows.length, k: rows.filter(r => !r.attributableUnsafe).length
  };
  return {
    rates: {
      merged: { ...r }, reviewOk: {
        n: 0, k: 0
      }, reworkFree: {
        n: 0, k: 0
      }
    }, costPerRunUsd: null
  };
}

function mean(rows: readonly ClaimLearningOutcome[], metric: 'waitMs' | 'idleMs', minimum: number): number | null {
  const values = rows.map(r => r[metric]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length >= minimum ? (values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2) : null;
}

export function evaluateClaimLearningCell(input: ClaimLearningCellInput) {
  const now = input.now.toISOString();
  const prior: ClaimLearningPolicy = input.prior ?? {
    delta: .05, minConfidence: .85, fraction: 1, dial: 5, record: {
      state: 'shifted', since: now, alternateArmId: 'jev_start'
    }
  };
  const validDelta = Number.isFinite(prior.delta) && prior.delta >= 0 && prior.delta <= 1;
  const delta = Number.isFinite(prior.delta) && prior.delta >= 0 && prior.delta <= 1 ? prior.delta : .05;
  const minimum = Math.max(20, input.minSamplePerArm ?? prior.minSamplePerArm ?? 20);
  const rows = unique(input.outcomes.filter(treatment));
  const base = unique(input.baseline.filter(control));
  const baseRate = rate(base), unsafeRate = rate(rows);
  const upper95 = claimUnsafeUpper95(rows.filter(r => r.attributableUnsafe).length, rows.length);
  const enough = rows.length >= minimum && base.length >= minimum;
  const safetyOk = enough && upper95! <= baseRate! + delta;
  const improvement = (['waitMs', 'idleMs'] as const).some(metric => {
    const a = mean(rows, metric, minimum), b = mean(unique(input.controlOutcomes ?? base).filter(r => !r.staleBlocker), metric, minimum);
    return a !== null && b !== null && a < b;
  });
  const nextDial = (prior.fraction === 0 ? 2 : Math.min(5, prior.dial + 1)) as Dial;
  const common = {
    now: input.now, primary: {
      armId: 'deterministic_hold', evidence: evidence(base)
    }, alternates: [{
        armId: 'jev_start', model: 'Jev START', evidence: evidence(rows), inCell: evidence(rows)
      }], primaryInCellSinceShift: evidence(base), gradedPerDay: 0
  };
  let decision: DialDecision;
  // Like the shared dial, promotion needs a bound and reversion uses observed harm.
  // A wide interval with no observed harm withholds an increase; it is not a breach.
  // Safety takes priority over an owner pin. Keep the shared reverted representation,
  // evidence boundary and cooldown; the adapter supplies overlap-attributed evidence.
  if ((!validDelta || (enough && unsafeRate! > baseRate! + delta)) && prior.record.state !== 'reverted') {
    const reason = validDelta ? 'observed attributable unsafe rate exceeded the matched base rate plus policy delta' : 'invalid policy delta: deterministic HOLD until a valid policy is recorded';
    decision = {
      record: {
        state: 'reverted', since: now, revertedAt: now, evidenceSince: now, revertReason: reason, revertedFrom: 'Jev START', alternateArmId: null
      }, share: 0, alternateArmId: null, event: {
        kind: 'revert', reason, evidence: {
          baseRate, unsafeRate, delta, gate: input.gate, area: input.area, fingerprint: input.fingerprint, upper95, validDelta
        }
      }
    };
  }
  else if (prior.record.state === 'reverted') {
    decision = decideDialCell({
      ...common, dial: prior.dial, prior: prior.record
    });
  }
  else if (!prior.pinned && safetyOk && improvement && (prior.dial < 5 || prior.fraction === 0)) {
    // Evaluate the next share through the same non-inferiority state machine.
    decision = decideDialCell({
      ...common, dial: nextDial, prior: {
        ...prior.record, state: 'learning'
      }
    });
    if (decision.record.state !== 'shifted') {
      decision = {
        record: prior.record, share: prior.fraction, alternateArmId: prior.record.alternateArmId ?? null
      };
    }
  }
  else {
    decision = {
      record: prior.record, share: prior.fraction, alternateArmId: prior.record.alternateArmId ?? null
    };
  }
  const raised = decision.event?.kind === 'promotion';
  const dial = raised ? nextDial : prior.dial;
  const fraction = decision.record.state === 'shifted' ? (raised ? DIAL_SETTINGS[dial].maxShare : decision.share) : 0;
  const policy: ClaimLearningPolicy = {
    ...prior, delta, minSamplePerArm: minimum, dial, fraction, record: decision.record, minConfidence: calibrateClaimConfidence(input.outcomes, input.baseline, delta, minimum)
  };
  return {
    policy, decision, safety: {
      baseRate, attributableUnsafeRate: unsafeRate, attributableUnsafeUpper95: upper95, minimum, jevSamples: rows.length, baseSamples: base.length, enough, safetyOk, improvement
    }, candidates: {
      falseHold: input.outcomes.filter(r => clean(r) && r.actor === 'human_force' && r.matchedJevLabel === 'HOLD' && r.attributableUnsafe === false).length, falseStart: rows.filter(r => r.attributableUnsafe === true).length
    }, ownershipHygiene: input.outcomes.filter(r => r.staleBlocker).length
  };
}
