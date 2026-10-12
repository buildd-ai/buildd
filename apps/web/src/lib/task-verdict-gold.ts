/**
 * Outcome-derived gold for the task verdict's model questions
 * (lib/task-verdict-decision.ts, capability `task_verdict`).
 *
 * The rules decide a task's verdict state; the model answers three narrower
 * questions, and the gold is in their vocabulary:
 *
 *  - **headline** (`fix_pr_metadata | fix_code | rerun_checks`), asked when a
 *    PR is blocked by red checks. The next completed run on the PR says which:
 *      - green on the same head, PR text untouched  → `rerun_checks`
 *      - green on the same head after a PR text edit → `fix_pr_metadata`
 *      - green on a new head that is a real change   → `fix_code`
 *      - red again on the same head                  → `not:rerun_checks`
 *        (re-running did not help; which fix was needed is not claimed)
 *  - **mismatch_diagnosis** (`wrong_check | fix_not_applied | flaky_ci`): only
 *    flaky is mechanical. Green on the same head → `flaky_ci`; red again on the
 *    same head, or green only after a push → `not:flaky_ci`.
 *  - **error_class** (`real | noise`): nothing that happens later says whether
 *    a probe's non-zero exit mattered. Always unknown.
 *
 * Unknown, with no label: no answer, no later run, no recorded head, the PR
 * closed unmerged, a new head that only merged the base (or might have), red
 * on a new head, or a text edit whose timing is unknown. Never guessed.
 *
 * A `not:<answer>` label marks one answer wrong and scores nothing else.
 *
 * Storage: these decisions are `orchestration_decisions` rows, and
 * `decision_outcomes.decision_record_id` is a non-null reference to
 * `decision_records`, so the gold has nowhere to be written yet. Pure until
 * the outcome table can point at an orchestration decision.
 */
import type { DecisionObjective } from '@buildd/core/decision-readout';
import type { VerdictDecisionKind } from './task-verdict-decision';

export const TASK_VERDICT_GOLD_SOURCE = 'verdict_followup';

const HEADLINE = ['fix_pr_metadata', 'fix_code', 'rerun_checks'] as const;
const MISMATCH = ['wrong_check', 'fix_not_applied', 'flaky_ci'] as const;
const ERROR_CLASS = ['real', 'noise'] as const;
const ANSWERS: Record<VerdictDecisionKind, readonly string[]> = { headline: HEADLINE, mismatch_diagnosis: MISMATCH, error_class: ERROR_CLASS };

export interface VerdictGoldInput {
  kind: VerdictDecisionKind;
  /** The model's answer. */
  answer: string | null;
  /** The PR head when the question was asked (`orchestration_decisions.head_sha`). */
  decidedHeadSha: string | null;
  /** The first completed check run on the PR after the decision. */
  nextRun: { conclusion: 'success' | 'failure'; headSha: string; at: Date } | null;
  /** The PR title or body changed between the decision and that run. Null: unknown. */
  prTextEditedBeforeRun: boolean | null;
  /** The run's new head differs from the decided one only by merging the base. Null: unknown. */
  newHeadOnlyMergedBase: boolean | null;
  prClosedUnmerged: boolean;
}

export type VerdictGoldReason = 'passed_unchanged' | 'passed_after_text_edit' | 'passed_after_push' | 'failed_unchanged';
export type VerdictUnknownReason =
  | 'no_answer' | 'no_mechanical_truth' | 'pr_closed' | 'head_missing' | 'no_next_run'
  | 'text_edit_unknown' | 'push_only_merged_base' | 'failed_after_push';

export type VerdictGold =
  | { status: 'labelled'; label: string; reason: VerdictGoldReason }
  | { status: 'unknown'; reason: VerdictUnknownReason };

const unknown = (reason: VerdictUnknownReason): VerdictGold => ({ status: 'unknown', reason });
const labelled = (label: string, reason: VerdictGoldReason): VerdictGold => ({ status: 'labelled', label, reason });

export function gradeVerdictDecision(input: VerdictGoldInput): VerdictGold {
  if (!input.answer || !ANSWERS[input.kind]?.includes(input.answer)) return unknown('no_answer');
  if (input.kind === 'error_class') return unknown('no_mechanical_truth');
  if (input.prClosedUnmerged) return unknown('pr_closed');
  if (!input.decidedHeadSha) return unknown('head_missing');
  const run = input.nextRun;
  if (!run) return unknown('no_next_run');
  const sameHead = run.headSha === input.decidedHeadSha;

  if (input.kind === 'mismatch_diagnosis') {
    if (sameHead) return run.conclusion === 'success' ? labelled('flaky_ci', 'passed_unchanged') : labelled('not:flaky_ci', 'failed_unchanged');
    if (run.conclusion === 'failure') return unknown('failed_after_push');
    if (input.newHeadOnlyMergedBase !== false) return unknown('push_only_merged_base');
    return labelled('not:flaky_ci', 'passed_after_push');
  }

  if (sameHead) {
    if (run.conclusion === 'failure') return labelled('not:rerun_checks', 'failed_unchanged');
    if (input.prTextEditedBeforeRun === null) return unknown('text_edit_unknown');
    return input.prTextEditedBeforeRun ? labelled('fix_pr_metadata', 'passed_after_text_edit') : labelled('rerun_checks', 'passed_unchanged');
  }
  if (run.conclusion === 'failure') return unknown('failed_after_push');
  if (input.newHeadOnlyMergedBase !== false) return unknown('push_only_merged_base');
  return labelled('fix_code', 'passed_after_push');
}

/** `<answer>` is the right answer; `not:<answer>` says only that one answer was wrong. */
export const taskVerdictObjective: DecisionObjective = {
  source: TASK_VERDICT_GOLD_SOURCE,
  score(outcome, answer) {
    if (outcome.label.startsWith('not:')) return outcome.label.slice(4) === answer ? false : null;
    const pool = [HEADLINE, MISMATCH].find(p => (p as readonly string[]).includes(outcome.label));
    if (!pool || !(pool as readonly string[]).includes(answer)) return null;
    return outcome.label === answer;
  },
};
