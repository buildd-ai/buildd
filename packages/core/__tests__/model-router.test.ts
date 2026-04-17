import { describe, it, expect } from 'bun:test';
import { resolveEffectiveModel } from '../model-router';

describe('resolveEffectiveModel', () => {
  it('explicit override bypasses every gate', () => {
    const d = resolveEffectiveModel({
      explicitModel: 'claude-opus-4-7',
      kind: 'engineering',
      complexity: 'simple',
      dailyBudgetPct: 0.99,
    });
    expect(d.model).toBe('claude-opus-4-7');
    expect(d.reason).toBe('explicit_override');
  });

  it('defaults to engineering/normal → sonnet when kind/complexity missing', () => {
    const d = resolveEffectiveModel({});
    expect(d.model).toBe('sonnet');
    expect(d.reason).toBe('baseline');
  });

  it('simple engineering → haiku', () => {
    const d = resolveEffectiveModel({ kind: 'engineering', complexity: 'simple' });
    expect(d.model).toBe('haiku');
  });

  it('complex engineering → opus', () => {
    const d = resolveEffectiveModel({ kind: 'engineering', complexity: 'complex' });
    expect(d.model).toBe('opus');
  });

  it('coordination always → opus regardless of complexity', () => {
    for (const complexity of ['simple', 'normal', 'complex'] as const) {
      expect(
        resolveEffectiveModel({ kind: 'coordination', complexity }).model,
      ).toBe('opus');
    }
  });

  it('observation stays at haiku even at complex', () => {
    const d = resolveEffectiveModel({ kind: 'observation', complexity: 'complex' });
    expect(d.model).toBe('haiku');
  });

  describe('budget-pressure gate', () => {
    it('0–70% honours baseline', () => {
      const d = resolveEffectiveModel({
        kind: 'engineering', complexity: 'complex', dailyBudgetPct: 0.5,
      });
      expect(d.model).toBe('opus');
      expect(d.downshifted).toBe(false);
    });

    it('70–90% downshifts engineering/writing/analysis', () => {
      const d = resolveEffectiveModel({
        kind: 'engineering', complexity: 'complex', dailyBudgetPct: 0.75,
      });
      expect(d.model).toBe('sonnet');
      expect(d.reason).toBe('budget_downshift');
      expect(d.downshifted).toBe(true);

      const w = resolveEffectiveModel({
        kind: 'writing', complexity: 'normal', dailyBudgetPct: 0.75,
      });
      expect(w.model).toBe('haiku');
    });

    it('70–90% does NOT downshift coordination', () => {
      const d = resolveEffectiveModel({
        kind: 'coordination', dailyBudgetPct: 0.8,
      });
      expect(d.model).toBe('opus');
      expect(d.downshifted).toBe(false);
    });

    it('90–95% downshifts everything except coordination', () => {
      const eng = resolveEffectiveModel({
        kind: 'engineering', complexity: 'complex', dailyBudgetPct: 0.92,
      });
      expect(eng.model).toBe('sonnet');

      const design = resolveEffectiveModel({
        kind: 'design', complexity: 'complex', dailyBudgetPct: 0.92,
      });
      expect(design.model).toBe('sonnet');

      // coordination stays at baseline Opus in the 90–95% band; it only drops
      // to Sonnet at 95%+ (see next test).
      const coord = resolveEffectiveModel({
        kind: 'coordination', dailyBudgetPct: 0.92,
      });
      expect(coord.model).toBe('opus');
      expect(coord.downshifted).toBe(false);
    });

    it('95%+ pauses non-priority tasks', () => {
      const d = resolveEffectiveModel({
        kind: 'engineering', complexity: 'normal', dailyBudgetPct: 0.96, priority: 0,
      });
      expect(d.model).toBe('paused');
      expect(d.reason).toBe('paused');
    });

    it('95%+ still runs priority > 0 tasks with a downshift', () => {
      const d = resolveEffectiveModel({
        kind: 'engineering', complexity: 'complex', dailyBudgetPct: 0.96, priority: 5,
      });
      expect(d.model).toBe('sonnet');
      expect(d.reason).toBe('budget_downshift');
    });

    it('95%+ forces coordination to Sonnet (never pause)', () => {
      const d = resolveEffectiveModel({
        kind: 'coordination', dailyBudgetPct: 0.97, priority: 0,
      });
      expect(d.model).toBe('sonnet');
      expect(d.reason).toBe('budget_downshift');
    });
  });

  describe('spike-detection gate', () => {
    it('fires when recent claims exceed threshold', () => {
      const d = resolveEffectiveModel({
        kind: 'engineering', complexity: 'complex',
        dailyBudgetPct: 0.3, recentClaimCount: 25, spikeThreshold: 20,
      });
      expect(d.model).toBe('sonnet');
      expect(d.reason).toBe('spike_downshift');
    });

    it('does not fire for coordination even on spike', () => {
      const d = resolveEffectiveModel({
        kind: 'coordination',
        dailyBudgetPct: 0.3, recentClaimCount: 50,
      });
      expect(d.model).toBe('opus');
    });

    it('does not double-downshift with budget gate', () => {
      const d = resolveEffectiveModel({
        kind: 'engineering', complexity: 'complex',
        dailyBudgetPct: 0.75, recentClaimCount: 50,
      });
      expect(d.model).toBe('sonnet'); // single downshift only
    });
  });

  describe('role floor clamp', () => {
    it('clamps up to the workspace-configured floor', () => {
      const d = resolveEffectiveModel({
        kind: 'engineering', complexity: 'simple', roleFloor: 'sonnet',
      });
      expect(d.model).toBe('sonnet');
      expect(d.reason).toBe('role_floor_clamp');
    });

    it('ignores `inherit` floor', () => {
      const d = resolveEffectiveModel({
        kind: 'engineering', complexity: 'simple', roleFloor: 'inherit',
      });
      expect(d.model).toBe('haiku');
    });

    it('does not reduce above the floor', () => {
      const d = resolveEffectiveModel({
        kind: 'engineering', complexity: 'complex', roleFloor: 'haiku',
      });
      expect(d.model).toBe('opus');
    });
  });
});
