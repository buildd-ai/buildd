import { describe, expect, it } from 'bun:test';
import {
  STRAND_GOLD_SOURCE,
  STRAND_GOLD_WINDOW_MS,
  gradeStrandChoice,
  strandChoiceObjective,
  type StrandGoldInput,
} from './strand-choice-gold';

const DECIDED = new Date('2026-10-01T10:00:00Z');
const HOUR = 3_600_000;
const at = (h: number) => new Date(DECIDED.getTime() + h * HOUR);

function input(over: Partial<StrandGoldInput> = {}): StrandGoldInput {
  return {
    verdict: 'wait-for-local',
    decidedAt: DECIDED,
    now: at(48),
    localClaimsAt: [],
    runnerClaimsAt: [],
    tap: null,
    missionEnded: false,
    ...over,
  };
}

describe('gradeStrandChoice', () => {
  it('the local session coming back inside the window makes wait-for-local right', () => {
    const g = gradeStrandChoice(input({ localClaimsAt: [at(2)] }));
    expect(g).toEqual({ status: 'labelled', right: 'wait-for-local', reason: 'local_returned', decisionWasRight: true, afterMinutes: 120 });
  });

  it('work moving to a runner first makes continue-on-runner right', () => {
    const g = gradeStrandChoice(input({ runnerClaimsAt: [at(1)], localClaimsAt: [at(3)] }));
    expect(g).toMatchObject({ status: 'labelled', right: 'continue-on-runner', reason: 'moved_to_runner', decisionWasRight: false, afterMinutes: 60 });
  });

  it('the owner tapping Continue on a runner counts as moving it, at the tap', () => {
    const g = gradeStrandChoice(input({ verdict: 'continue-on-runner', tap: { button: 'continue-on-runner', at: at(0.5) }, runnerClaimsAt: [at(1)] }));
    expect(g).toMatchObject({ right: 'continue-on-runner', reason: 'owner_moved_to_runner', decisionWasRight: true, afterMinutes: 30 });
  });

  it('a tap on Keep local is not evidence that the session came back', () => {
    const g = gradeStrandChoice(input({ tap: { button: 'wait-for-local', at: at(0.2) }, localClaimsAt: [at(1)] }));
    expect(g).toMatchObject({ right: 'wait-for-local', reason: 'local_returned' });
    // With nothing else, the window decides.
    expect(gradeStrandChoice(input({ tap: { button: 'wait-for-local', at: at(0.2) } }))).toMatchObject({ right: 'continue-on-runner', reason: 'local_absent' });
  });

  it('the waited-on session never arriving within the window makes wait-for-local wrong', () => {
    const g = gradeStrandChoice(input({ localClaimsAt: [at(STRAND_GOLD_WINDOW_MS / HOUR + 1)] }));
    expect(g).toEqual({ status: 'labelled', right: 'continue-on-runner', reason: 'local_absent', decisionWasRight: false, afterMinutes: null });
  });

  it('events before the decision are ignored', () => {
    expect(gradeStrandChoice(input({ localClaimsAt: [at(-1)], runnerClaimsAt: [at(-2)] }))).toMatchObject({ reason: 'local_absent' });
  });

  it('blocked-on-deps is labelled for the record but never scored right or wrong', () => {
    expect(gradeStrandChoice(input({ verdict: 'blocked-on-deps', localClaimsAt: [at(1)] })))
      .toMatchObject({ status: 'labelled', right: 'wait-for-local', decisionWasRight: null });
  });

  describe('unknown: never guessed', () => {
    it('no model answer', () => {
      expect(gradeStrandChoice(input({ verdict: null }))).toEqual({ status: 'unknown', reason: 'no_answer' });
      expect(gradeStrandChoice(input({ verdict: 'something-else' }))).toEqual({ status: 'unknown', reason: 'no_answer' });
    });

    it('the window is still open and nothing has happened yet', () => {
      expect(gradeStrandChoice(input({ now: at(1) }))).toEqual({ status: 'unknown', reason: 'window_open' });
    });

    it('an event inside a still-open window already settles it', () => {
      expect(gradeStrandChoice(input({ now: at(1), localClaimsAt: [at(0.5)] }))).toMatchObject({ status: 'labelled', reason: 'local_returned' });
    });

    it('the mission ended with nothing claimed', () => {
      expect(gradeStrandChoice(input({ missionEnded: true }))).toEqual({ status: 'unknown', reason: 'mission_ended' });
    });

    it('a session and a runner claiming at the same moment', () => {
      expect(gradeStrandChoice(input({ localClaimsAt: [at(1)], runnerClaimsAt: [at(1)] }))).toEqual({ status: 'unknown', reason: 'simultaneous' });
    });
  });
});

describe('strandChoiceObjective', () => {
  it('reads its own source and scores the two actionable answers', () => {
    expect(strandChoiceObjective.source).toBe(STRAND_GOLD_SOURCE);
    const o = { label: 'wait-for-local', value: 120 };
    expect(strandChoiceObjective.score(o, 'wait-for-local')).toBe(true);
    expect(strandChoiceObjective.score(o, 'continue-on-runner')).toBe(false);
    expect(strandChoiceObjective.score(o, 'blocked-on-deps')).toBeNull();
    expect(strandChoiceObjective.score({ label: 'human_choice', value: null }, 'wait-for-local')).toBeNull();
  });
});
