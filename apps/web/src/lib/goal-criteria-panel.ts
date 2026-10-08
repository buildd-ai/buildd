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
 *     reach a verdict without a model, so the sheet offers the fix instead;
 *   - say the validator's refusals in product words. The raw text (which names
 *     backend criterion types) stays available as an optional detail.
 */
import type { GoalCriterion, GoalCriteriaState } from '@buildd/shared';
import {
  criterionFingerprint,
  validateGoalCriteria,
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
  | {
      kind: 'needs_check';
      headline: string;
      reason: string;
      actionLabel: string;
      /**
       * A check Buildd can already answer from what the mission has produced,
       * added in one tap. Null when there is nothing to infer from — the action
       * then opens the add form.
       */
      suggestion: GoalCriterion | null;
    };

/**
 * Can "Run verification" reach a verdict? Not without at least one automatic
 * check: the server refuses to store such a list, and a grandfathered one
 * could only ever be graded by a model.
 */
export function verificationReadiness(args: {
  criteria: readonly GoalCriterion[];
  /** Distinct PRs the mission has opened. */
  missionPrCount: number;
}): VerificationReadiness {
  if (args.criteria.length === 0) return { kind: 'empty' };
  if (args.criteria.some(isAutomaticCheck)) return { kind: 'ready' };
  const suggestion: GoalCriterion | null = args.missionPrCount > 0 ? { type: 'all_prs_merged' } : null;
  return {
    kind: 'needs_check',
    headline: 'Can’t verify automatically yet.',
    reason: suggestion
      ? 'Nothing here can be checked without AI, but this mission’s PRs can be.'
      : 'This mission doesn’t have a check Buildd can run on its own.',
    actionLabel: suggestion ? 'Check that every PR merged' : 'Add check',
    suggestion,
  };
}

export interface PlainError {
  text: string;
  /** The validator's own words, for a "details" disclosure. Null when `text` is already them. */
  detail: string | null;
}

const NEEDS_AUTOMATIC_CHECK =
  'Add at least one check Buildd can run on its own, like every PR merged or a script that passes.';

/** Say a criteria refusal in product words; keep the raw text as an optional detail. */
export function plainCriteriaError(message: string): PlainError {
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

/**
 * Validate a criterion the way the server will see it: as one row of the
 * whole list it joins. `siblings` are the other criteria that will be saved
 * with it, already stored, so they are grandfathered exactly as PATCH does.
 */
export function validateCriterionInContext(
  candidate: GoalCriterion,
  siblings: readonly GoalCriterion[],
): PlainError | null {
  const row = validateGoalCriteria([candidate], { requireMechanical: false });
  if (row) return plainCriteriaError(row);
  const whole = validateGoalCriteria([...siblings, candidate], { stored: siblings });
  return whole ? plainCriteriaError(whole) : null;
}
