import { describe, expect, it } from 'bun:test';
import { reviewAllSummary } from './review-all-view';

describe('Review all summary', () => {
  it('shows the question in place of the summary when the author asked one', () => {
    expect(reviewAllSummary({ question: 'Ship refunds?', explanationSummary: 'Adds refunds.', changeSummary: 'x' })).toBe('Ship refunds?');
  });
  it('falls back to the explanation summary, then the change summary', () => {
    expect(reviewAllSummary({ question: null, explanationSummary: 'Adds refunds.', changeSummary: 'x' })).toBe('Adds refunds.');
    expect(reviewAllSummary({ question: null, explanationSummary: null, changeSummary: ' x ' })).toBe('x');
    expect(reviewAllSummary({ question: null, explanationSummary: null, changeSummary: null })).toBeNull();
  });
});
