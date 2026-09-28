import { describe, expect, it } from 'bun:test';
import { defineTierPolicy } from '@builddai/ai-kit/chat/contract';

describe('defineTierPolicy', () => {
  it('without options is the kit as before: Auto default, budget / standard / premium', () => {
    const p = defineTierPolicy();
    expect(p.offer).toEqual(['budget', 'standard', 'premium']);
    expect(p.defaultTier).toBeNull();
    expect(p.auto).toBe(true);
    expect(p.label('budget')).toBe('Budget');
    expect(p.label('premium-plus')).toBe('Premium+');
    expect(p.label(null)).toBe('Auto');
  });

  it("an app's default, labels and offer (Cue: Economy / Balanced / Best, no Auto, no premium-plus)", () => {
    const p = defineTierPolicy({
      offer: ['budget', 'standard', 'premium'],
      defaultTier: 'budget',
      auto: false,
      labels: { budget: 'Economy', standard: 'Balanced', premium: 'Best' },
    });
    expect(p.defaultTier).toBe('budget');
    expect(p.options({ budget: 'Haiku' })).toEqual([
      { tier: 'budget', label: 'Economy', price: 'Haiku' },
      { tier: 'standard', label: 'Balanced' },
      { tier: 'premium', label: 'Best' },
    ]);
    expect(p.isOffered('premium-plus')).toBe(false);
    expect(p.accepts(null)).toBe(false);
    expect(p.accepts('standard')).toBe(true);
    expect(p.accepts('opus')).toBe(false);
  });

  it('resolve: saved choice → app default; unoffered, unknown and (without Auto) null are skipped', () => {
    const p = defineTierPolicy({ defaultTier: 'budget', auto: false });
    expect(p.resolve('premium')).toBe('premium');
    expect(p.resolve(undefined)).toBe('budget');
    expect(p.resolve(null)).toBe('budget');
    expect(p.resolve('premium-plus')).toBe('budget');
    expect(p.resolve('bogus', 'standard')).toBe('standard');
    const withAuto = defineTierPolicy({ defaultTier: 'budget' });
    expect(withAuto.resolve(null)).toBeNull();
    expect(withAuto.resolve(undefined)).toBe('budget');
  });

  it('default without Auto: standard when offered, else the first offered', () => {
    expect(defineTierPolicy({ auto: false }).defaultTier).toBe('standard');
    expect(defineTierPolicy({ auto: false, offer: ['budget', 'premium'] }).defaultTier).toBe('budget');
  });

  it('rejects a default it does not offer, Auto as default without Auto, and an empty offer', () => {
    expect(() => defineTierPolicy({ offer: ['budget'], defaultTier: 'premium' })).toThrow(/not offered/);
    expect(() => defineTierPolicy({ auto: false, defaultTier: null })).toThrow(/Auto/);
    expect(() => defineTierPolicy({ offer: [] })).toThrow(/at least one/);
    expect(() => defineTierPolicy({ offer: ['opus' as never] })).toThrow(/unknown tier/);
  });
});
