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
import { REPAIR_PHASE_WORDS, repairLabelOf, repairPhaseOf, reviewSummaryLine, reviewSummaryOf, type DeliveryView, type RepairPhase, type ReviewSummary } from '@/lib/workflow/projections';

export interface PrDeliveryReport {
  state: DeliveryView['state'];
  headline: string;
  detail: string | null;
  needsYou: boolean;
  review: (ReviewSummary & { line: string }) | null;
  repairs: Array<{ label: string; phase: RepairPhase; words: string; taskId: string | null }>;
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
    repairs,
  };
}
