import { describe, it, expect } from 'bun:test';
import { isDispatchedReview, isReadOnlyReview } from './read-only-review';

describe('isDispatchedReview', () => {
  it('needs both the review category and a reviewed task', () => {
    expect(isDispatchedReview('review', { reviewerFor: 'task-1' })).toBe(true);
    expect(isDispatchedReview('review', {})).toBe(false);
    expect(isDispatchedReview('review', { reviewerFor: '' })).toBe(false);
    expect(isDispatchedReview('review', null)).toBe(false);
    expect(isDispatchedReview('bug', { reviewerFor: 'task-1' })).toBe(false);
  });

  it('is the one predicate: the read-only name is the same function', () => {
    expect(isReadOnlyReview).toBe(isDispatchedReview);
  });
});
