import { describe, expect, it } from 'bun:test';
import { deriveTaskType, stripTaskTypePrefix } from '../mission-helpers';

describe('deriveTaskType', () => {
  it('returns null for a primary task (no parentTaskId)', () => {
    expect(deriveTaskType({ title: 'Fix auth bug', parentTaskId: null })).toBe(null);
  });

  it('returns null for a primary task even with bracket prefix in title', () => {
    expect(deriveTaskType({ title: '[CI Retry #1] Fix auth bug', parentTaskId: null })).toBe(null);
  });

  it('returns retry for CI retry title', () => {
    expect(deriveTaskType({ title: '[CI Retry #1] Fix auth bug', parentTaskId: 'parent-id' })).toBe('retry');
    expect(deriveTaskType({ title: '[CI Retry #2] Fix auth bug', parentTaskId: 'parent-id' })).toBe('retry');
    expect(deriveTaskType({ title: '[CI Retry #99] Something', parentTaskId: 'parent-id' })).toBe('retry');
  });

  it('returns review for reviewer title', () => {
    expect(deriveTaskType({ title: '[reviewer] Fix auth bug', parentTaskId: 'parent-id' })).toBe('review');
    expect(deriveTaskType({ title: '[Reviewer] Fix auth bug', parentTaskId: 'parent-id' })).toBe('review');
  });

  it('returns review-retry for reviewer retry title', () => {
    expect(deriveTaskType({ title: '[reviewer retry #1] Fix auth bug', parentTaskId: 'parent-id' })).toBe('review-retry');
    expect(deriveTaskType({ title: '[reviewer retry #2] Something', parentTaskId: 'parent-id' })).toBe('review-retry');
    expect(deriveTaskType({ title: '[Reviewer Retry #1] Fix auth bug', parentTaskId: 'parent-id' })).toBe('review-retry');
  });

  it('returns retry as fallback for attempt task with unrecognized prefix', () => {
    expect(deriveTaskType({ title: '[Something] Fix auth bug', parentTaskId: 'parent-id' })).toBe('retry');
  });

  it('returns retry for attempt task with no prefix', () => {
    expect(deriveTaskType({ title: 'Fix auth bug', parentTaskId: 'parent-id' })).toBe('retry');
  });

  it('handles undefined parentTaskId as null', () => {
    expect(deriveTaskType({ title: '[CI Retry #1] Fix', parentTaskId: undefined })).toBe(null);
  });
});

describe('stripTaskTypePrefix', () => {
  it('strips CI retry prefix', () => {
    expect(stripTaskTypePrefix('[CI Retry #1] Fix auth bug')).toBe('Fix auth bug');
    expect(stripTaskTypePrefix('[CI Retry #2] Fix auth bug')).toBe('Fix auth bug');
  });

  it('strips reviewer prefix', () => {
    expect(stripTaskTypePrefix('[reviewer] Fix auth bug')).toBe('Fix auth bug');
    expect(stripTaskTypePrefix('[Reviewer] Fix auth bug')).toBe('Fix auth bug');
  });

  it('strips reviewer retry prefix', () => {
    expect(stripTaskTypePrefix('[reviewer retry #1] Fix auth bug')).toBe('Fix auth bug');
  });

  it('strips any bracket prefix generically', () => {
    expect(stripTaskTypePrefix('[CI Retry #2 reviewer] Fix auth bug')).toBe('Fix auth bug');
    expect(stripTaskTypePrefix('[Something Else] Fix auth bug')).toBe('Fix auth bug');
  });

  it('leaves titles without prefix unchanged', () => {
    expect(stripTaskTypePrefix('Fix auth bug')).toBe('Fix auth bug');
    expect(stripTaskTypePrefix('')).toBe('');
  });

  it('handles extra whitespace after prefix', () => {
    expect(stripTaskTypePrefix('[reviewer]   Fix auth bug')).toBe('Fix auth bug');
  });
});
