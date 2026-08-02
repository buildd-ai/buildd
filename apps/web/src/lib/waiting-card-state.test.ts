import { describe, it, expect } from 'bun:test';
import { resolveWaitingCardState } from './waiting-card-state';

describe('resolveWaitingCardState', () => {
  it('returns merged_resolved for merged lifecycle status', () => {
    expect(resolveWaitingCardState('merged')).toBe('merged_resolved');
  });

  it('returns closed_warning for closed lifecycle status', () => {
    expect(resolveWaitingCardState('closed')).toBe('closed_warning');
  });

  it('returns full for null lifecycle status — null must never false-collapse', () => {
    expect(resolveWaitingCardState(null)).toBe('full');
  });

  it('returns full for undefined lifecycle status', () => {
    expect(resolveWaitingCardState(undefined)).toBe('full');
  });

  it('returns full for open lifecycle status', () => {
    expect(resolveWaitingCardState('open')).toBe('full');
  });

  it('returns full for unknown lifecycle status values', () => {
    expect(resolveWaitingCardState('pr_open')).toBe('full');
  });
});
