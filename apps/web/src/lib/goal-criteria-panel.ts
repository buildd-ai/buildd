/**
 * Derivations behind the mission's Goal criteria sheet (`MissionGoalCriteria`).
 *
 * Pure (no React, no I/O) so the sheet's state and CTA logic is testable
 * without mounting it, and importable from either side of the client boundary.
 *
 * Three jobs:
 *   - join stored verdicts to criteria by identity, not array slot, so a row
 *     never shows evidence produced for a criterion that is no longer there;
 *   - preflight "Run verification": a list with no automatic check cannot
 *     reach a verdict without a model, so the sheet says so and points at
 *     selecting a spec. It never offers to add a hand-written criterion:
 *     those are retired (Living Specs D-44);
 *   - say the validator's refusals in product words. The raw text (which names
 *     backend criterion types) stays available as an optional detail.
 */
import type { GoalCriterion, GoalCriteriaState } from '@buildd/shared';
import {
  criterionFingerprint,
  MECHANICAL_CRITERION_TYPES,
} from '@buildd/core/mission-helpers';

export type CriterionStateEntry = GoalCriteriaState['criteria'][number];

/** A check Buildd answers itself, without a model reading prose. */
export function isAutomaticCheck(c: { type: string }): boolean {
  return (MECHANICAL_CRITERION_TYPES as readonly string[]).includes(c.type);
}

/**
 * Stored verdict for each criterion, index-aligned with `criteria`; null when
 * the stored state holds nothing for that criterion as it is now.
 *
 * Matched on `fingerprint` — the identity `criterionFingerprint` defines and
 * the evaluator writes. Joining on `index` showed a deleted or edited
 * criterion's evidence under whatever now sits in that slot (e.g. a row
 * relabelled for a merged PR still reading "No PRs found" from an earlier
 * run). A state written before fingerprints existed is read by slot only when
 * the slot still holds the same type and label.
 */
export function joinCriteriaState(
  criteria: readonly GoalCriterion[],
  state: GoalCriteriaState | null | undefined,
): Array<CriterionStateEntry | null> {
  const entries = state?.criteria ?? [];
  const used = new Set<CriterionStateEntry>();
  return criteria.map((c, i) => {
    const fp = criterionFingerprint(c);
    // Same slot first, so two identical criteria keep their own verdicts.
    const byFingerprint =
      entries.find(e => e.fingerprint === fp && e.index === i && !used.has(e))
      ?? entries.find(e => e.fingerprint === fp && !used.has(e));
    if (byFingerprint) {
      used.add(byFingerprint);
      return byFingerprint;
    }
    const legacy = entries.find(
      e => !e.fingerprint && e.index === i && e.type === c.type && (e.label ?? '') === (c.label ?? '') && !used.has(e),
    );
    if (legacy) {
      used.add(legacy);
      return legacy;
    }
    return null;
  });
}

export type VerificationReadiness =
  | { kind: 'empty' }
  | { kind: 'ready' }
  | { kind: 'needs_check'; headline: string; reason: string };

/**
 * Can "Run verification" reach a verdict? Not without at least one automatic
 * check: the server refuses to store such a list, and a grandfathered one
 * could only ever be graded by a model. The way out is the mission's outcome
 * spec, whose criteria carry their own checks; adding a hand-written check is
 * no longer offered (Living Specs D-44).
 */
export function verificationReadiness(args: {
  criteria: readonly GoalCriterion[];
}): VerificationReadiness {
  if (args.criteria.length === 0) return { kind: 'empty' };
  if (args.criteria.some(isAutomaticCheck)) return { kind: 'ready' };
  return {
    kind: 'needs_check',
    headline: 'Can’t verify automatically yet.',
    reason: 'Nothing here can be checked without AI. Select the spec this mission delivers: its checks run on their own.',
  };
}

export interface PlainError {
  text: string;
  /** The validator's own words, for a "details" disclosure. Null when `text` is already them. */
  detail: string | null;
}

const NEEDS_AUTOMATIC_CHECK =
  'Add at least one check buildd can run on its own, like every PR merged or a script that passes.';

/** Say a criteria refusal in product words; keep the raw text as an optional detail. */
export function plainCriteriaError(message: string): PlainError {
  if (/criteria are retired/.test(message)) {
    return { text: 'Hand-written criteria are retired. Select the spec this mission delivers instead.', detail: message };
  }
  if (/must include at least one mechanical criterion/.test(message)) {
    return { text: NEEDS_AUTOMATIC_CHECK, detail: message };
  }
  if (/is a prose criterion/.test(message) || /notMechanizableReason/.test(message)) {
    return {
      text: 'Say in a sentence why this can’t be checked automatically.',
      detail: message,
    };
  }
  if (/metric criteria have no evaluator/.test(message)) {
    return { text: 'Measured goals can’t be checked yet. Use a script that passes instead.', detail: message };
  }
  if (/^goalCriteria\[\d+\]/.test(message)) {
    const text = message
      .replace(/^goalCriteria\[\d+\]\.(\w+)/, (_m, field: string) => `The ${field} field`)
      .replace(/^goalCriteria\[\d+\]/, 'This check');
    return { text, detail: message };
  }
  return { text: message, detail: null };
}
