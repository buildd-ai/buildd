import { describe, it, expect } from 'bun:test';
import { isReplyableQuestion } from './mission-note-reply';
import { CRITERIA_ESCALATION_NOTE_TITLE } from './criteria-escalation-note';

describe('isReplyableQuestion', () => {
  it('is true for an ordinary open question note', () => {
    expect(isReplyableQuestion({ type: 'question', status: 'open', title: 'Which backend?' })).toBe(true);
  });

  it('is false for a closed question note', () => {
    expect(isReplyableQuestion({ type: 'question', status: 'answered', title: 'Which backend?' })).toBe(false);
  });

  it('is false for a non-question note', () => {
    expect(isReplyableQuestion({ type: 'update', status: 'open', title: 'Which backend?' })).toBe(false);
  });

  it('is false for the goal-criteria escalation note — reply would mute it without re-arming', () => {
    expect(isReplyableQuestion({ type: 'question', status: 'open', title: CRITERIA_ESCALATION_NOTE_TITLE })).toBe(false);
  });
});
