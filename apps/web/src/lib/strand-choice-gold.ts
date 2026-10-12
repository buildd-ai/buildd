/**
 * Outcome-derived gold for the stranded-local-mission choice
 * (`mission_strand_choice`, lib/strand-choice-decision.ts).
 *
 * The model is asked, while a local mission's claimable work sits untouched,
 * whether to wait for the person's own session or move the work to a runner.
 * What happened next answers it, measured from the decision:
 *
 *  - **wait-for-local** was right when an interactive session (`workers.runner
 *    = 'mcp'`) claimed one of the mission's tasks within the window, before any
 *    move to a runner: the waited-on local work arrived.
 *  - **continue-on-runner** was right when the work moved to a runner first: a
 *    runner claimed a task, or the owner tapped "Continue on a runner". It is
 *    also the right answer when the window closed and no session ever came
 *    back: waiting did not get the work done.
 *
 * A tap on "Keep local" is not evidence: it says what the person preferred,
 * not that their session arrived. Taps stay observational (button order can
 * bias them), so a tap counts only as the moment the work moved.
 *
 * `blocked-on-deps` gets the label too (any model's answer on the same case is
 * scored from it) but is never scored right or wrong: neither event says
 * whether the work was waiting on its dependencies.
 *
 * Unknown, with no label: no model answer, the window still open with nothing
 * yet, the mission ended with nothing claimed, or a session and a runner
 * claiming at the same moment. Never guessed.
 *
 * The label is the right answer in the decision's own vocabulary, so
 * `strandChoiceObjective` can score any model's answer, not only Jev's. Pure.
 */
import type { DecisionObjective } from '@buildd/core/decision-readout';
import type { StrandChoiceLabel } from './strand-choice-decision';

// The decision's labels, without loading the decision module (it registers prompts on import).
const STRAND_ANSWERS = ['continue-on-runner', 'wait-for-local', 'blocked-on-deps'] as const satisfies readonly StrandChoiceLabel[];

/** The outcome source a strand-choice gold label is recorded under. */
export const STRAND_GOLD_SOURCE = 'strand_followup';

/**
 * How long a session may take to come back and still count as "soon". The
 * card itself reads stranded after 30 minutes of quiet; a session back within
 * the working day is what waiting bets on.
 */
export const STRAND_GOLD_WINDOW_MS = 6 * 60 * 60 * 1000;

export type StrandGoldAnswer = 'wait-for-local' | 'continue-on-runner';

export interface StrandGoldInput {
  /** The model's answer on the record (`decision_records.verdict`). */
  verdict: string | null;
  decidedAt: Date;
  now: Date;
  /** When an interactive session claimed one of the mission's tasks. */
  localClaimsAt: readonly Date[];
  /** When a background runner claimed one of the mission's tasks. */
  runnerClaimsAt: readonly Date[];
  /** The owner's tap on this decision's card, if any. */
  tap: { button: string; at: Date } | null;
  /** The mission is completed, archived or cancelled. */
  missionEnded: boolean;
}

export type StrandGoldReason = 'local_returned' | 'moved_to_runner' | 'owner_moved_to_runner' | 'local_absent';
export type StrandUnknownReason = 'no_answer' | 'window_open' | 'mission_ended' | 'simultaneous';

export type StrandGold =
  | {
    status: 'labelled';
    right: StrandGoldAnswer;
    reason: StrandGoldReason;
    /** Null for an answer the gold does not score (`blocked-on-deps`). */
    decisionWasRight: boolean | null;
    /** Minutes from the decision to the event; null when the window closed without one. */
    afterMinutes: number | null;
  }
  | { status: 'unknown'; reason: StrandUnknownReason };

const isGoldAnswer = (s: string): s is StrandGoldAnswer => s === 'wait-for-local' || s === 'continue-on-runner';

/** The earliest time in [from, until], or null. */
function firstIn(times: readonly Date[], from: number, until: number): number | null {
  let best: number | null = null;
  for (const d of times) {
    const t = d.getTime();
    if (Number.isFinite(t) && t >= from && t <= until && (best === null || t < best)) best = t;
  }
  return best;
}

export function gradeStrandChoice(input: StrandGoldInput): StrandGold {
  const verdict = input.verdict;
  if (!verdict || !(STRAND_ANSWERS as readonly string[]).includes(verdict)) return { status: 'unknown', reason: 'no_answer' };

  const from = input.decidedAt.getTime();
  const until = from + STRAND_GOLD_WINDOW_MS;
  const local = firstIn(input.localClaimsAt, from, until);
  const runnerClaim = firstIn(input.runnerClaimsAt, from, until);
  const tapped = input.tap?.button === 'continue-on-runner' ? firstIn([input.tap.at], from, until) : null;
  const runner = runnerClaim === null ? tapped : tapped === null ? runnerClaim : Math.min(runnerClaim, tapped);

  const labelled = (right: StrandGoldAnswer, reason: StrandGoldReason, t: number | null): StrandGold => ({
    status: 'labelled',
    right,
    reason,
    decisionWasRight: isGoldAnswer(verdict) ? verdict === right : null,
    afterMinutes: t === null ? null : Math.round((t - from) / 60_000),
  });

  if (local !== null && runner !== null && local === runner) return { status: 'unknown', reason: 'simultaneous' };
  if (local !== null && (runner === null || local < runner)) return labelled('wait-for-local', 'local_returned', local);
  if (runner !== null) return labelled('continue-on-runner', runner === tapped && runner !== runnerClaim ? 'owner_moved_to_runner' : 'moved_to_runner', runner);

  if (input.missionEnded) return { status: 'unknown', reason: 'mission_ended' };
  if (input.now.getTime() < until) return { status: 'unknown', reason: 'window_open' };
  return labelled('continue-on-runner', 'local_absent', null);
}

/** Scores wait-for-local / continue-on-runner against the gold; null for anything else. */
export const strandChoiceObjective: DecisionObjective = {
  source: STRAND_GOLD_SOURCE,
  score(outcome, answer) {
    if (!isGoldAnswer(outcome.label) || !isGoldAnswer(answer)) return null;
    return outcome.label === answer;
  },
};
