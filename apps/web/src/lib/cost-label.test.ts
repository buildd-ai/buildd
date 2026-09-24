import { describe, it, expect } from 'bun:test';
import { formatEstimatedUsd, ESTIMATED_COST_TITLE } from './cost-label';

describe('formatEstimatedUsd', () => {
  it('labels a dollar figure as an estimate', () => {
    expect(formatEstimatedUsd(1.234)).toBe('$1.23 est.');
  });

  it('honours the requested precision', () => {
    expect(formatEstimatedUsd(0.01234, 4)).toBe('$0.0123 est.');
    expect(formatEstimatedUsd(12, 0)).toBe('$12 est.');
  });

  it('accepts the numeric strings drizzle returns for decimal columns', () => {
    expect(formatEstimatedUsd('3.5')).toBe('$3.50 est.');
  });

  it('renders non-finite or missing input as zero rather than "$NaN"', () => {
    expect(formatEstimatedUsd(Number.NaN)).toBe('$0.00 est.');
    expect(formatEstimatedUsd(null)).toBe('$0.00 est.');
    expect(formatEstimatedUsd(undefined)).toBe('$0.00 est.');
  });
});

describe('ESTIMATED_COST_TITLE', () => {
  it('says the figure is a list-price equivalent, not a charge, on seat auth', () => {
    expect(ESTIMATED_COST_TITLE).toContain('list price');
    expect(ESTIMATED_COST_TITLE).toContain('OAuth');
    expect(ESTIMATED_COST_TITLE).toContain('not a charge');
  });
});
