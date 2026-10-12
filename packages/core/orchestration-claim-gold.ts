/**
 * Outcome-derived gold for the claim hold/start decision
 * (`buildd.orchestration_claim_hold`, capability `orchestration_claim`).
 *
 * The decision is about two tasks: the `candidate` the claim rule held, and
 * the `holder` it was held behind. Once both have settled, what their merged
 * PRs actually changed says which answer was right:
 *
 *  - **START** was right when both PRs merged, their files were disjoint and
 *    neither needed a conflict-resolution retry. It was wrong when a conflict
 *    or migration-collision retry followed on either side, or one PR
 *    superseded the other.
 *  - **HOLD** was right when the merged diffs intersected, and wrong (an
 *    unnecessary wait) when they were disjoint.
 *
 * Anything else is unknown and gets no label: a side missing, cancelled, not
 * settled, never merged, or merged with no file list; a START whose diffs
 * overlapped yet merged cleanly (neither proven safe nor proven harmful). An
 * empty file list is missing evidence, not proof of disjointness.
 *
 * The gold is the answer that would have been right, in the decision's own
 * vocabulary (`START` | `HOLD`), so any model's answer on the same case can be
 * scored against it (`claimHoldObjective`), not only the one that was applied.
 *
 * Pure. Loading the evidence and persisting the label live elsewhere.
 */
import type { DecisionObjective } from './decision-readout';

export type ClaimGoldAnswer = 'START' | 'HOLD';

/** The outcome source a claim gold label is recorded under. */
export const CLAIM_GOLD_SOURCE = 'claim_merged_diff';

export interface ClaimGoldSide {
  taskId: string;
  taskStatus: string;
  /** The task's PR; null when it opened none. */
  pr: {
    number: number;
    mergedAt: Date | null;
    /** The files the PR changed as merged; null when unknown. */
    files: readonly string[] | null;
  } | null;
  /** A conflict-resolution or migration-collision retry was filed for this side after the decision. */
  conflictRetry: boolean;
}

export interface ClaimGoldInput {
  /** What the decision answered (the effective answer, or a model's suggestion). */
  answer: ClaimGoldAnswer;
  candidate: ClaimGoldSide | null;
  holder: ClaimGoldSide | null;
  /** One side's PR superseded the other's after the decision. */
  superseded: boolean;
}

export type ClaimGoldReason =
  | 'start_disjoint_clean'
  | 'start_conflict_retry'
  | 'start_superseded'
  | 'hold_overlap'
  | 'hold_disjoint';

export type ClaimUnknownReason =
  | 'no_answer'
  | 'start_overlap_without_conflict'
  | `${'candidate' | 'holder'}_${'missing' | 'cancelled' | 'not_settled' | 'no_pr' | 'not_merged' | 'files_missing'}`;

export type ClaimGold =
  | { status: 'labelled'; right: ClaimGoldAnswer; decisionWasRight: boolean; reason: ClaimGoldReason }
  | { status: 'unknown'; reason: ClaimUnknownReason };

const SETTLED = new Set(['completed', 'failed']);

const unknown = (reason: ClaimUnknownReason): ClaimGold => ({ status: 'unknown', reason });

function labelled(answer: ClaimGoldAnswer, right: ClaimGoldAnswer, reason: ClaimGoldReason): ClaimGold {
  return { status: 'labelled', right, decisionWasRight: answer === right, reason };
}

/** Repo-relative paths, trimmed, deduped, without a leading `./` or blanks. */
function normalizeFiles(files: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    if (typeof f !== 'string') continue;
    const p = f.trim().replace(/^(\.\/)+/, '');
    if (p) out.add(p);
  }
  return out;
}

function settledness(name: 'candidate' | 'holder', side: ClaimGoldSide | null): ClaimUnknownReason | null {
  if (!side) return `${name}_missing`;
  if (side.taskStatus === 'cancelled') return `${name}_cancelled`;
  if (!SETTLED.has(side.taskStatus)) return `${name}_not_settled`;
  return null;
}

function mergedFiles(name: 'candidate' | 'holder', side: ClaimGoldSide): Set<string> | ClaimUnknownReason {
  if (!side.pr) return `${name}_no_pr`;
  if (!side.pr.mergedAt) return `${name}_not_merged`;
  const files = side.pr.files ? normalizeFiles(side.pr.files) : null;
  if (!files || files.size === 0) return `${name}_files_missing`;
  return files;
}

/** The gold for one hold/start decision, or why there is none. */
export function gradeClaimDecision(input: ClaimGoldInput): ClaimGold {
  const { answer } = input;
  if (answer !== 'START' && answer !== 'HOLD') return unknown('no_answer');

  const unsettled = settledness('candidate', input.candidate) ?? settledness('holder', input.holder);
  if (unsettled) return unknown(unsettled);
  const candidate = input.candidate!;
  const holder = input.holder!;

  // A START that cost a repair is wrong however the PRs ended up.
  if (answer === 'START') {
    if (candidate.conflictRetry || holder.conflictRetry) return labelled(answer, 'HOLD', 'start_conflict_retry');
    if (input.superseded) return labelled(answer, 'HOLD', 'start_superseded');
  }

  const candFiles = mergedFiles('candidate', candidate);
  if (typeof candFiles === 'string') return unknown(candFiles);
  const holdFiles = mergedFiles('holder', holder);
  if (typeof holdFiles === 'string') return unknown(holdFiles);

  let overlap = false;
  for (const f of candFiles) if (holdFiles.has(f)) { overlap = true; break; }

  if (answer === 'START') return overlap ? unknown('start_overlap_without_conflict') : labelled(answer, 'START', 'start_disjoint_clean');
  return overlap ? labelled(answer, 'HOLD', 'hold_overlap') : labelled(answer, 'START', 'hold_disjoint');
}

const isAnswer = (s: string): s is ClaimGoldAnswer => s === 'START' || s === 'HOLD';

/** Scores an answer against the gold's right answer; null outside the START/HOLD vocabulary. */
export const claimHoldObjective: DecisionObjective = {
  source: CLAIM_GOLD_SOURCE,
  score(outcome, answer) {
    if (!isAnswer(outcome.label) || !isAnswer(answer)) return null;
    return outcome.label === answer;
  },
};
