import { describe, expect, it } from 'bun:test';
import { formatCost, formatPer1k, tierChipLabel } from './composer-format';

describe('formatCost', () => {
  it('nothing spent: no label', () => {
    expect(formatCost(null)).toBe('');
    expect(formatCost(0)).toBe('');
  });
  it('under a cent reads as <$0.01; otherwise two decimals', () => {
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.0421)).toBe('$0.04');
    expect(formatCost(1.5)).toBe('$1.50');
  });
});

describe('formatPer1k', () => {
  it('two significant figures, no trailing zeros', () => {
    expect(formatPer1k(0.015)).toBe('$0.015');
    expect(formatPer1k(0.003)).toBe('$0.003');
    expect(formatPer1k(0.00025)).toBe('$0.00025');
    expect(formatPer1k(0.0018333)).toBe('$0.0018');
    expect(formatPer1k(0)).toBe('$0');
  });
});

describe('tierChipLabel', () => {
  it('pinned shows the pin; auto shows the last tier it ran on', () => {
    expect(tierChipLabel({ pinned: 'premium', last: 'budget' })).toBe('premium');
    expect(tierChipLabel({ pinned: null, last: 'budget' })).toBe('auto · budget');
    expect(tierChipLabel({ pinned: null, last: null })).toBe('auto');
  });
});
