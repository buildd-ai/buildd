import { describe, expect, it } from 'bun:test';
import { readModelPin, isTaskTier, isAcceptableModelPin } from '../model-pin';

describe('readModelPin', () => {
  it('no context or no model → no pin', () => {
    expect(readModelPin(null)).toBeNull();
    expect(readModelPin({})).toBeNull();
    expect(readModelPin({ model: '  ' })).toBeNull();
  });

  it('explicit marker wins in both directions', () => {
    expect(readModelPin({ model: 'claude-x', modelPinned: true, routingReason: 'baseline' })).toBe('claude-x');
    expect(readModelPin({ model: 'claude-x', modelPinned: false, routingReason: 'explicit_override' })).toBeNull();
  });

  it('unmarked model never claimed (no routingReason) is a caller pin', () => {
    expect(readModelPin({ model: 'claude-x' })).toBe('claude-x');
  });

  it('unmarked model with a routed reason is the claim route output, not a pin', () => {
    for (const reason of ['baseline', 'budget_downshift', 'role_floor', 'spike_downshift']) {
      expect(readModelPin({ model: 'claude-x', routingReason: reason })).toBeNull();
    }
  });

  it('unmarked explicit_override stays a pin (conservative for legacy rows)', () => {
    expect(readModelPin({ model: 'claude-x', routingReason: 'explicit_override' })).toBe('claude-x');
  });
});

describe('pin validation', () => {
  it('tier vocabulary', () => {
    expect(isTaskTier('premium-plus')).toBe(true);
    expect(isTaskTier('budget')).toBe(true);
    expect(isTaskTier('opus')).toBe(false);
    expect(isTaskTier(null)).toBe(false);
  });

  it('model shape', () => {
    expect(isAcceptableModelPin('claude-opus-4-8')).toBe(true);
    expect(isAcceptableModelPin('anthropic/claude-sonnet-5')).toBe(true);
    expect(isAcceptableModelPin('claude-sonnet-4-6[1m]')).toBe(true);
    expect(isAcceptableModelPin('sonnet')).toBe(true);
    expect(isAcceptableModelPin('gpt-5')).toBe(false);
    expect(isAcceptableModelPin('claude opus')).toBe(false);
    expect(isAcceptableModelPin('')).toBe(false);
  });
});
