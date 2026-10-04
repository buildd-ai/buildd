/**
 * What a visual review decision does (docs/design/visual-qa-human-review.md,
 * part 1 and "The deck queue"). Pure and client-safe: the decisions route
 * plans with it, and the deck labels its buttons with the same rule.
 *
 * | Agent said | Looks right                          | Needs fix                              |
 * |------------|--------------------------------------|----------------------------------------|
 * | ok         | agree, record only                   | dispute: file a `[surface fix]`        |
 * | issue      | dispute: cancel the linked fix while | agree: a note goes to the fix as       |
 * |            | pending and unclaimed, else guidance | guidance                               |
 * | unsure     | waive, record only                   | dispute: file a fix, as for ok         |
 */
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import type {
  VisualQaVerdict,
  VisualReviewAnnotation,
  VisualReviewDecision,
  VisualReviewOutcome,
  VisualReviewRelation,
} from '@buildd/shared';

/** What a decision does beyond recording itself. */
export type ShotReviewIntent = 'none' | 'file_fix' | 'waive_fix' | 'guide_fix';

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUSES);

/**
 * One shot's relation and intent. `linkedFix` is the cell's fix (an earlier
 * human fix, else the auditor's `qa.fixTaskId`) with its status, or null when
 * the shot never had one.
 *
 * A linked fix that completed means the shot predates the fix and its
 * re-check round is what shows whether it worked: Needs fix on it records the
 * human's view and files nothing, rather than a duplicate fix off a pre-fix
 * screenshot. A fix that failed or was cancelled solved nothing, so Needs fix
 * files again.
 */
export function planShotReviewEffect(
  agentVerdict: VisualQaVerdict,
  decision: VisualReviewDecision,
  opts: { linkedFix: { id: string; status: string } | null; hasNote: boolean },
): { relation: VisualReviewRelation; intent: ShotReviewIntent } {
  const open = !!opts.linkedFix && !TERMINAL.has(opts.linkedFix.status);
  const fixDone = opts.linkedFix?.status === 'completed';
  if (agentVerdict === 'ok' || agentVerdict === 'unsure') {
    if (decision === 'looks_right') return { relation: agentVerdict === 'ok' ? 'agree' : 'waive', intent: 'none' };
    // An open earlier human fix is reused by planDecision rather than filed twice.
    return { relation: 'dispute', intent: fixDone ? 'none' : 'file_fix' };
  }
  // issue
  if (decision === 'looks_right') return { relation: 'dispute', intent: open ? 'waive_fix' : 'none' };
  if (open) return { relation: 'agree', intent: opts.hasNote ? 'guide_fix' : 'none' };
  return { relation: 'agree', intent: fixDone ? 'none' : 'file_fix' };
}

export interface DecisionOutcomeInput {
  decision: VisualReviewDecision;
  /** Every shot of the request: its agent verdict, whether it is a fix check, and whether its linked fix is open. */
  shots: ReadonlyArray<{ agentVerdict: VisualQaVerdict; check: boolean; linkedOpen: boolean }>;
  /** A new fix was filed. */
  filed: boolean;
  /** An open human fix was reused instead. */
  reused: boolean;
  /** A fix was cancelled. */
  cancelled: boolean;
  /** Why fixes got a guidance note. */
  annotated: ReadonlyArray<VisualReviewAnnotation['reason']>;
  /** The round-cap note is open: the last automatic round already ran. */
  roundCapOpen: boolean;
}

/**
 * What the server did, as one outcome for the confirmation. A request with
 * more than one effect reports the first in the design doc's table order.
 */
export function decisionOutcome(o: DecisionOutcomeInput): VisualReviewOutcome {
  if (o.decision === 'needs_fix') {
    if (o.filed) return 'fix_filed';
    if (o.reused) return 'fix_added';
    if (o.annotated.includes('note')) return 'fix_noted';
    if (o.shots.some(s => s.linkedOpen)) return o.roundCapOpen ? 'fix_kept_no_recheck' : 'fix_kept';
    return 'fix_done';
  }
  if (o.cancelled) return 'fix_cancelled';
  if (o.annotated.includes('started')) return 'fix_started';
  if (o.annotated.includes('still_linked')) return 'fix_still_linked';
  if (o.shots.some(s => s.check)) return 'marked_fixed';
  if (o.shots.some(s => s.agentVerdict === 'issue')) return 'not_a_bug';
  return 'marked_fine';
}
