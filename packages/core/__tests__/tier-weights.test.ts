import { describe, it, expect } from 'bun:test';
import {
  WEIGHT_VALUES,
  backfillWeights,
  blendedPrice,
  displayPercents,
  isWeightLevel,
  nearestWeightForShare,
  sharesFromWeights,
  suggestWeight,
} from '../tier-weights';
import type { TokenPrice } from '../model-catalog';

const INC = 'inc';
const C1 = 'c1';
const C2 = 'c2';
const C3 = 'c3';

describe('sharesFromWeights', () => {
  // docs/design/tier-weights.md §1 examples table.
  const cases: Array<[Record<string, string>, string[], Record<string, number>]> = [
    [{ [INC]: 'high', [C1]: 'low' }, [INC, C1], { [INC]: 0.75, [C1]: 0.25 }],
    [{ [INC]: 'high', [C1]: 'med' }, [INC, C1], { [INC]: 0.6, [C1]: 0.4 }],
    [{ [INC]: 'med', [C1]: 'med' }, [INC, C1], { [INC]: 0.5, [C1]: 0.5 }],
    [{ [INC]: 'high', [C1]: 'med', [C2]: 'low' }, [INC, C1, C2], { [INC]: 0.5, [C1]: 0.3333, [C2]: 0.1667 }],
    [{ [INC]: 'high', [C1]: 'med', [C2]: 'med', [C3]: 'low' }, [INC, C1, C2, C3], { [INC]: 0.375, [C1]: 0.25, [C2]: 0.25, [C3]: 0.125 }],
    [{ [INC]: 'high', [C1]: 'off' }, [INC, C1], { [INC]: 1, [C1]: 0 }],
  ];
  for (const [weights, armOrder, want] of cases) {
    it(`${JSON.stringify(weights)} -> ${JSON.stringify(want)}`, () => {
      const r = sharesFromWeights(weights as never, armOrder);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (const [id, share] of Object.entries(want)) expect(r.allocation[id]).toBeCloseTo(share, 3);
      expect(Object.values(r.allocation).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    });
  }

  it('rejects an all-off pool', () => {
    const r = sharesFromWeights({ [INC]: 'off', [C1]: 'off' } as never, [INC, C1]);
    expect(r).toEqual({ ok: false, error: expect.any(String) });
  });

  it('ties in the largest remainder break by armOrder', () => {
    // high + med + med + low: exact percents are 37.5/25/25/12.5. The two
    // 0.5 remainders (high and low) tie; armOrder (incumbent first) wins it.
    const pct = displayPercents({ [INC]: 'high', [C1]: 'med', [C2]: 'med', [C3]: 'low' } as never, [INC, C1, C2, C3]);
    expect(pct).toEqual({ [INC]: 38, [C1]: 25, [C2]: 25, [C3]: 12 });
    expect(Object.values(pct).reduce((s, v) => s + v, 0)).toBe(100);
  });
});

describe('displayPercents', () => {
  it('always sums to 100 when any arm is above off', () => {
    const pct = displayPercents({ [INC]: 'high', [C1]: 'med', [C2]: 'low' } as never, [INC, C1, C2]);
    expect(Object.values(pct).reduce((s, v) => s + v, 0)).toBe(100);
    expect(pct).toEqual({ [INC]: 50, [C1]: 33, [C2]: 17 });
  });
  it('reads as all zero when every arm is off', () => {
    expect(displayPercents({ [INC]: 'off' } as never, [INC])).toEqual({ [INC]: 0 });
  });
});

describe('WEIGHT_VALUES / isWeightLevel', () => {
  it('is 0/1/2/3 for off/low/med/high', () => {
    expect(WEIGHT_VALUES).toEqual({ off: 0, low: 1, med: 2, high: 3 });
  });
  it('validates known levels only', () => {
    expect(isWeightLevel('med')).toBe(true);
    expect(isWeightLevel('medium')).toBe(false);
    expect(isWeightLevel(2)).toBe(false);
  });
});

describe('nearestWeightForShare / backfillWeights', () => {
  it('snaps a share to the nearest level by threshold', () => {
    expect(nearestWeightForShare(0)).toBe('off');
    expect(nearestWeightForShare(0.1)).toBe('low');
    expect(nearestWeightForShare(0.5)).toBe('med');
    expect(nearestWeightForShare(1)).toBe('high');
  });
  it('fills only the arms a legacy pool has no level for yet', () => {
    const out = backfillWeights({ [INC]: 'high' } as never, [{ id: INC, share: 1 }, { id: C1, share: 0.2 }]);
    expect(out).toEqual({ [INC]: 'high', [C1]: 'med' });
  });
});

describe('suggestWeight', () => {
  const incumbent: TokenPrice = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }; // blended = (12+20)/4 = 8
  it('a pricier challenger suggests low', () => {
    const pricier: TokenPrice = { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 }; // blended = (24+40)/4 = 16, ratio 2.0
    expect(suggestWeight(pricier, incumbent)).toBe('low');
  });
  it('a comparable-price challenger suggests med', () => {
    const comparable: TokenPrice = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }; // ratio 1.0
    expect(suggestWeight(comparable, incumbent)).toBe('med');
  });
  it('a much cheaper challenger also suggests med — never high', () => {
    const cheaper: TokenPrice = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }; // ratio 0.25
    expect(suggestWeight(cheaper, incumbent)).toBe('med');
  });
  it('a right-at-the-line ratio (1.25) still counts as comparable', () => {
    const atLine: TokenPrice = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }; // blended = (15+25)/4 = 10, ratio 1.25
    expect(suggestWeight(atLine, incumbent)).toBe('med');
  });
  it('an unknown price on either side suggests low', () => {
    expect(suggestWeight(null, incumbent)).toBe('low');
    expect(suggestWeight(incumbent, null)).toBe('low');
    expect(suggestWeight(null, null)).toBe('low');
  });
});

describe('blendedPrice', () => {
  it('weights input 3:1 over output', () => {
    expect(blendedPrice({ input: 4, output: 20, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo((3 * 4 + 20) / 4);
  });
});
