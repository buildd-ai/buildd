/**
 * What `get_pr` says about a kernel-owned PR's delivery
 * (docs/specs/workflow-kernel-library.md §7): where it stands, its review
 * rounds and each repair's phase, all from the DeliveryView. Pure and
 * JSON-safe: the route returns it as `delivery`, the MCP formatter prints it.
 *
 * The review reading is `reviewSummaryOf`, the one the task page's checks list
 * and the PR activity comment print, so the three agree (AC-24). GitHub review
 * counts stay in `reviews` for a PR that has no delivery.
 */
import { reviewRoundsOf, type ReviewRoundsReading } from '@/lib/pr-activity-rounds';
import { decisionCopy, type DecisionCopy } from '@/components/escalation-decision-copy';
import { REPAIR_PHASE_WORDS, repairLabelOf, repairPhaseOf, reviewSummaryLine, reviewSummaryOf, type DeliveryView, type RepairPhase, type ReviewSummary } from '@/lib/workflow/projections';

export interface PrDeliveryReport {
  state: DeliveryView['state'];
  headline: string;
  detail: string | null;
  needsYou: boolean;
  review: (ReviewSummary & { line: string }) | null;
  /** AC-24: each round with buildd's verdict at its head, and the note that GitHub lists those reviews as Commented. */
  rounds: ReviewRoundsReading | null;
  /** AC-43: on a review escalation, the question, why automation stopped, the findings left and the actions open now. */
  decision: Pick<DecisionCopy, 'question' | 'why' | 'unresolved'> & { actions: Array<{ id: string; label: string }> } | null;
  repairs: Array<{ label: string; phase: RepairPhase; words: string; taskId: string | null }>;
  /** R-43: the `Buildd / Review approval` status on the head, apart from CI; null when none is published. */
  reviewApproval: { state: 'success' | 'failure' | 'pending'; description: string } | null;
}

export function prDeliveryReport(v: DeliveryView): PrDeliveryReport {
  const summary = reviewSummaryOf(v);
  // Agent repairs only: a mechanical attempt is the platform updating the branch.
  const ledger = v.ledger ?? [];
  const repairs = ledger
    .filter(a => a.mode === 'agent')
    .sort((a, b) => a.family.localeCompare(b.family) || a.attemptNo - b.attemptNo)
    .map(a => {
      const phase = repairPhaseOf(a, v);
      // get_pr says "of up to" (#5006); N counts the attempts that ran (295486ba).
      return { label: repairLabelOf(a, ledger, { upTo: true }), phase, words: REPAIR_PHASE_WORDS[phase], taskId: a.taskId };
    });
  return {
    state: v.state,
    headline: v.headline,
    detail: v.detail,
    needsYou: v.needsYou,
    review: summary ? { ...summary, line: reviewSummaryLine(summary) } : null,
    rounds: reviewRoundsOf(v.rounds),
    decision: decisionOf(v),
    repairs,
    reviewApproval: v.reviewApproval ?? null,
  };
}

function decisionOf(v: DeliveryView): PrDeliveryReport['decision'] {
  if (!v.escalation) return null;
  const c = decisionCopy(v.escalation, { rounds: v.rounds, ledger: v.ledger ?? [] });
  return { question: c.question, why: c.why, unresolved: c.unresolved, actions: c.actions.map(a => ({ id: a.id, label: a.label })) };
}
