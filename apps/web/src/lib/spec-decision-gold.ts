/**
 * Outcome-derived labels for the two spec decisions that act on almost every
 * call: the duplicate check (`buildd.spec_duplicate`) and area filing
 * (`buildd.spec_area`). Neither has a person marking the model right or wrong,
 * so a later event does it (written by lib/spec-decision-grading.ts).
 *
 * Duplicate check. The model said `duplicate` (refused or warned):
 *  - the author superseded the named spec, or the named spec was later marked
 *    superseded by the new one: `superseded`, right;
 *  - the author overrode with a `distinctBecause` reason: `distinct_override`, wrong;
 *  - the author superseded some other spec: `superseded_other`, not scored.
 * The model said `distinct`:
 *  - the new spec was later superseded by a spec that already existed when it
 *    was written: `superseded_later`, wrong;
 *  - it stood, not superseded at all, for SPEC_STOOD_MS: `stood`, right.
 * An `overlap` answer is never labelled: nothing later says whether it was right.
 *
 * Area filing. The model chose an area (`area_N`):
 *  - a person moved or un-filed the spec, or undid the filing: `moved`, wrong;
 *  - the filing stood for SPEC_AREA_STAY_MS: `stayed`, right;
 *  - a person accepted the suggestion: `accepted`, right.
 * `new_area` and `unsure` are never scored: no area was chosen to move away from.
 *
 * Pure: no database, so the readout's objective lookup can load it.
 */
import type { DecisionObjective } from '@buildd/core/decision-readout';

/** The ledger capability ids (the kind ids). Spelled out so a read route need not import the decision modules; a test pins them. */
export const SPEC_DUPLICATE_KIND_ID = 'buildd.spec_duplicate';
export const SPEC_AREA_KIND_ID = 'buildd.spec_area';

export const SPEC_DUPLICATE_GOLD_SOURCE = 'spec_duplicate_followup';
export const SPEC_AREA_GOLD_SOURCE = 'spec_area_followup';

/** A new spec the check called distinct and nothing replaced for this long counts as right. */
export const SPEC_STOOD_MS = 30 * 24 * 60 * 60 * 1000;
/** A filing nobody moved for this long counts as right. */
export const SPEC_AREA_STAY_MS = 14 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Duplicate check ─────────────────────────────────────────────────────────

export type DuplicateGoldLabel = 'superseded' | 'distinct_override' | 'superseded_other' | 'superseded_later' | 'stood';

export interface DuplicateGoldInput {
  /** The model's answer on the record. */
  verdict: string | null;
  decidedAt: Date;
  now: Date;
  /** `decision_records.human_override.decision`, written when an author overrode a refusal. */
  override: string | null;
  /** The spec that was created after the check, when it can be found. */
  newSpec: { id: string; createdAt: Date } | null;
  /** The newest status change that superseded the new spec, if it is superseded now. */
  newSpecSupersededBy: { id: string; createdAt: Date; at: Date } | null;
  /** The spec the pair named, and what superseded it, if anything. */
  namedSupersededBy: { id: string; at: Date } | null;
}

export type DuplicateGold =
  | { status: 'labelled'; label: DuplicateGoldLabel; observedAt: Date; reason: string }
  | { status: 'unknown'; reason: 'not_scored' | 'no_spec' | 'open' };

export function gradeDuplicateDecision(i: DuplicateGoldInput): DuplicateGold {
  if (i.verdict === 'duplicate') {
    if (i.override === 'duplicate_superseded') return { status: 'labelled', label: 'superseded', observedAt: i.decidedAt, reason: 'override_supersedes_named' };
    if (i.override === 'superseded_other') return { status: 'labelled', label: 'superseded_other', observedAt: i.decidedAt, reason: 'override_supersedes_other' };
    if (i.override === 'distinct') return { status: 'labelled', label: 'distinct_override', observedAt: i.decidedAt, reason: 'override_distinct' };
    // A warning is not refused, so there is no override: the later event is the named spec being retired for the new one.
    if (i.newSpec && i.namedSupersededBy?.id === i.newSpec.id) {
      return { status: 'labelled', label: 'superseded', observedAt: i.namedSupersededBy.at, reason: 'named_superseded_by_new' };
    }
    return { status: 'unknown', reason: i.newSpec ? 'open' : 'no_spec' };
  }
  if (i.verdict === 'distinct') {
    if (!i.newSpec) return { status: 'unknown', reason: 'no_spec' };
    if (i.newSpecSupersededBy) {
      // Replaced by a spec that already existed: the pair was not distinct. Replaced by a later one: says nothing.
      return i.newSpecSupersededBy.createdAt < i.newSpec.createdAt
        ? { status: 'labelled', label: 'superseded_later', observedAt: i.newSpecSupersededBy.at, reason: 'new_superseded_by_existing' }
        : { status: 'unknown', reason: 'not_scored' };
    }
    if (i.now.getTime() - i.newSpec.createdAt.getTime() >= SPEC_STOOD_MS) {
      return { status: 'labelled', label: 'stood', observedAt: new Date(i.newSpec.createdAt.getTime() + SPEC_STOOD_MS), reason: 'stood' };
    }
    return { status: 'unknown', reason: 'open' };
  }
  return { status: 'unknown', reason: 'not_scored' };
}

/** `duplicate` is right when the named spec was replaced, wrong when the author said distinct; `distinct` the other way round. */
export const specDuplicateObjective: DecisionObjective = {
  source: SPEC_DUPLICATE_GOLD_SOURCE,
  score(outcome, answer) {
    if (answer === 'duplicate') return outcome.label === 'superseded' ? true : outcome.label === 'distinct_override' ? false : null;
    if (answer === 'distinct') return outcome.label === 'stood' ? true : outcome.label === 'superseded_later' ? false : null;
    return null;
  },
};

// ── Area filing ─────────────────────────────────────────────────────────────

export type AreaGoldLabel = 'moved' | 'stayed' | 'accepted';

export interface AreaGoldInput {
  /** `spec_filings.kind` and `.status` of the filing this decision made. */
  kind: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  now: Date;
  /** The area the filing put the spec under, and where the spec sits now. */
  filedParentId: string | null;
  currentParentId: string | null;
}

export type AreaGold =
  | { status: 'labelled'; label: AreaGoldLabel; observedAt: Date; reason: string }
  | { status: 'unknown'; reason: 'not_scored' | 'open' | 'changed_unrecorded' };

export function gradeAreaFiling(i: AreaGoldInput): AreaGold {
  if (i.kind === 'filed') {
    if (i.status === 'overridden' || i.status === 'undone') {
      return { status: 'labelled', label: 'moved', observedAt: i.resolvedAt ?? i.createdAt, reason: i.status };
    }
    if (i.status !== 'applied') return { status: 'unknown', reason: 'not_scored' };
    // Moved by something that wrote no filing row: not evidence either way.
    if (i.currentParentId !== i.filedParentId) return { status: 'unknown', reason: 'changed_unrecorded' };
    if (i.now.getTime() - i.createdAt.getTime() >= SPEC_AREA_STAY_MS) {
      return { status: 'labelled', label: 'stayed', observedAt: new Date(i.createdAt.getTime() + SPEC_AREA_STAY_MS), reason: 'stayed' };
    }
    return { status: 'unknown', reason: 'open' };
  }
  if (i.kind === 'suggested') {
    if (i.status === 'accepted') return { status: 'labelled', label: 'accepted', observedAt: i.resolvedAt ?? i.createdAt, reason: 'accepted' };
    // Dismissed says the person did not want this placement, not that the area was wrong.
    return i.status === 'open' ? { status: 'unknown', reason: 'open' } : { status: 'unknown', reason: 'not_scored' };
  }
  return { status: 'unknown', reason: 'not_scored' };
}

const isAreaSlot = (s: string) => /^area_\d+$/.test(s);

/** An area answer is right when it stayed or was accepted, wrong when moved; `new_area` and `unsure` are not scored. */
export const specAreaObjective: DecisionObjective = {
  source: SPEC_AREA_GOLD_SOURCE,
  score(outcome, answer) {
    if (!isAreaSlot(answer)) return null;
    return outcome.label === 'stayed' || outcome.label === 'accepted' ? true : outcome.label === 'moved' ? false : null;
  },
};

export const SPEC_GOLD_LOOKBACK_MS = 60 * DAY_MS;
