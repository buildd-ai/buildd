import { describe, expect, it } from 'bun:test';
import { boundForAll, boundFrom, limitOptions, withCap, hasSurfaceCaps } from './tier-limits-view';

describe('limitOptions', () => {
  it('has nothing disabled with no bound', () => {
    expect(limitOptions(null).every((o) => !o.disabled)).toBe(true);
  });
  it('disables tiers above the bound and No limit, with the reason', () => {
    const o = limitOptions('premium', 'the team');
    const by = Object.fromEntries(o.map((x) => [x.value, x]));
    expect(by['premium-plus'].disabled).toBe(true);
    expect(by['premium-plus'].description).toContain('the team');
    expect(by.none.disabled).toBe(true);
    expect(by.premium.disabled).toBe(false);
    expect(by.standard.disabled).toBe(false);
  });
});

describe('bounds', () => {
  const eff = { layers: [{ source: 'team', tier: 'premium' as const }, { source: 'member_self', tier: 'budget' as const }] };
  it('ignores the caller\'s own layer', () => expect(boundFrom(eff, 'member_self')).toBe('premium'));
  it('all-surfaces bound needs both surfaces bound', () => {
    expect(boundForAll('premium', null)).toBeNull();
    expect(boundForAll('standard', 'premium')).toBe('premium');
  });
});

describe('withCap', () => {
  it('keeps other keys and clears on none', () => {
    expect(withCap({ all: 'premium', chat: 'standard' }, 'agent', 'budget')).toEqual({ all: 'premium', chat: 'standard', agent: 'budget' });
    expect(withCap({ all: 'premium', chat: 'standard' }, 'chat', 'none')).toEqual({ all: 'premium' });
    expect(hasSurfaceCaps({ all: 'premium' })).toBe(false);
  });
});
