import { describe, it, expect } from 'bun:test';
import {
  VISUAL_REVIEW_SKIP_REASONS,
  isVisualReviewSkipReason,
  parseVisualReviewSkipNote,
  visualReviewSkipNoteBody,
} from '../surface-audit';

// Spec 072de598 r15 I-7 / AC-26: Skip is two buttons with an optional note.
describe('visual review Skip reasons', () => {
  it('names the two buttons in the words they show', () => {
    expect(VISUAL_REVIEW_SKIP_REASONS.wrong_or_stuck).toBe('The review is wrong or stuck');
    expect(VISUAL_REVIEW_SKIP_REASONS.ship_anyway).toBe('Ship it anyway');
    expect(isVisualReviewSkipReason('wrong_or_stuck')).toBe(true);
    expect(isVisualReviewSkipReason('nope')).toBe(false);
  });

  it('writes the button alone when there is no note, and needs no minimum length', () => {
    expect(visualReviewSkipNoteBody('ship_anyway')).toBe('Ship it anyway');
    expect(visualReviewSkipNoteBody('ship_anyway', '  ')).toBe('Ship it anyway');
    expect(visualReviewSkipNoteBody('wrong_or_stuck', 'ok')).toBe('The review is wrong or stuck: ok');
  });

  it('reads the button and the note back, and treats free text as a note with no button', () => {
    expect(parseVisualReviewSkipNote('Ship it anyway')).toEqual({ reason: 'ship_anyway', note: null });
    expect(parseVisualReviewSkipNote('The review is wrong or stuck: shots of the wrong page')).toEqual({ reason: 'wrong_or_stuck', note: 'shots of the wrong page' });
    expect(parseVisualReviewSkipNote('No screens changed for users')).toEqual({ reason: null, note: 'No screens changed for users' });
    expect(parseVisualReviewSkipNote(null)).toEqual({ reason: null, note: null });
  });
});
