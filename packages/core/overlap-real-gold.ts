/**
 * Outcome-derived gold for the overlap-real ordering decision
 * (`buildd.orchestration_overlap_real`, capability `orchestration_ordering`;
 * `./orchestration-overlap-decision.ts`).
 *
 * The decision is about a pair: a new task and an in-flight task whose scopes
 * overlap on paper. `REAL` keeps the pair ordered (a soft edge in the claim
 * planner); `NOT_REAL` lets them run side by side. Once both settle:
 *
 *  - **REAL** was right when either side needed a conflict or
 *    migration-collision retry after the decision, one PR superseded the
 *    other, or their merged diffs touched a common file.
 *  - **NOT_REAL** was right when both PRs merged with disjoint files and
 *    neither needed a repair: ordering them bought nothing.
 *
 * A repair settles it even when the other side has not finished: ordering
 * was what avoided it. Otherwise unknown, with no label: the size-bucket
 * decision that shares the capability, no answer, a side missing, cancelled,
 * unsettled, with no PR, unmerged, or merged with no file list. An empty file
 * list is missing evidence, not proof of disjointness.
 *
 * Storage: the decision is an `orchestration_decisions` row and
 * `decision_outcomes.decision_record_id` is a non-null reference to
 * `decision_records`, so the gold has nowhere to be written yet. Pure.
 */
import { isTerminalTaskStatus } from '@buildd/shared';
import type { DecisionObjective } from './decision-readout';

export const OVERLAP_GOLD_SOURCE = 'overlap_merged_diff';
export const OVERLAP_REAL_DECISION_ID = 'buildd.orchestration_overlap_real';

export type OverlapGoldAnswer = 'REAL' | 'NOT_REAL';

export interface OverlapGoldSide {
  taskStatus: string;
  pr: { mergedAt: Date | null; files: readonly string[] | null } | null;
  /** A conflict-resolution or migration-collision retry was filed for this side after the decision. */
  conflictRetry: boolean;
}

export interface OverlapGoldInput {
  /** `orchestration_decisions.decision_id`: the capability also carries the size-bucket decision. */
  decisionId: string;
  answer: string | null;
  newTask: OverlapGoldSide | null;
  other: OverlapGoldSide | null;
  /** One side's PR superseded the other's after the decision. */
  superseded: boolean;
}

export type OverlapGoldReason = 'conflict_retry' | 'superseded' | 'merged_overlap' | 'merged_disjoint_clean';
type SideName = 'new_task' | 'other';
export type OverlapUnknownReason =
  | 'not_overlap_decision' | 'no_answer'
  | `${SideName}_${'missing' | 'cancelled' | 'not_settled' | 'no_pr' | 'not_merged' | 'files_missing'}`;

export type OverlapGold =
  | { status: 'labelled'; right: OverlapGoldAnswer; reason: OverlapGoldReason; decisionWasRight: boolean }
  | { status: 'unknown'; reason: OverlapUnknownReason };

const isAnswer = (s: string | null): s is OverlapGoldAnswer => s === 'REAL' || s === 'NOT_REAL';

function settled(name: SideName, s: OverlapGoldSide | null): OverlapUnknownReason | null {
  if (!s) return `${name}_missing`;
  if (s.taskStatus === 'cancelled') return `${name}_cancelled`;
  if (!isTerminalTaskStatus(s.taskStatus)) return `${name}_not_settled`;
  return null;
}

function mergedFiles(name: SideName, s: OverlapGoldSide): Set<string> | OverlapUnknownReason {
  if (!s.pr) return `${name}_no_pr`;
  if (!s.pr.mergedAt) return `${name}_not_merged`;
  const files = new Set((s.pr.files ?? []).map(f => (typeof f === 'string' ? f.trim().replace(/^(\.\/)+/, '') : '')).filter(Boolean));
  return files.size > 0 ? files : `${name}_files_missing`;
}

export function gradeOverlapDecision(input: OverlapGoldInput): OverlapGold {
  if (input.decisionId !== OVERLAP_REAL_DECISION_ID) return { status: 'unknown', reason: 'not_overlap_decision' };
  const answer = input.answer;
  if (!isAnswer(answer)) return { status: 'unknown', reason: 'no_answer' };
  const labelled = (right: OverlapGoldAnswer, reason: OverlapGoldReason): OverlapGold =>
    ({ status: 'labelled', right, reason, decisionWasRight: answer === right });

  if (input.newTask?.conflictRetry || input.other?.conflictRetry) return labelled('REAL', 'conflict_retry');
  if (input.superseded) return labelled('REAL', 'superseded');

  const unsettled = settled('new_task', input.newTask) ?? settled('other', input.other);
  if (unsettled) return { status: 'unknown', reason: unsettled };
  const a = mergedFiles('new_task', input.newTask!);
  if (typeof a === 'string') return { status: 'unknown', reason: a };
  const b = mergedFiles('other', input.other!);
  if (typeof b === 'string') return { status: 'unknown', reason: b };
  for (const f of a) if (b.has(f)) return labelled('REAL', 'merged_overlap');
  return labelled('NOT_REAL', 'merged_disjoint_clean');
}

export const overlapRealObjective: DecisionObjective = {
  source: OVERLAP_GOLD_SOURCE,
  score(outcome, answer) {
    if (!isAnswer(outcome.label) || !isAnswer(answer)) return null;
    return outcome.label === answer;
  },
};
