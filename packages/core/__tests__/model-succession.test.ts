import { describe, expect, it } from 'bun:test';
import type { CatalogEntry } from '../model-catalog';
import { compareVersions, decayMultiplier, findSuccessor, versionTuple } from '../model-succession';

const DAY = 86_400;
const T0 = 1_780_000_000;
const NOW = T0 + 400 * DAY;

function entry(id: string, over: Partial<CatalogEntry> = {}): CatalogEntry {
  const provider = id.startsWith('claude') ? 'anthropic' : id.startsWith('gpt') ? 'openai' : 'other';
  return {
    id, canonicalId: null, openRouterId: `${provider}/${id}`, permaslug: `${provider}/${id}`, provider,
    displayName: id, contextLength: 400_000, created: T0, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75,
    ...over,
  };
}

const arm = (model: string, route: 'runner:claude' | 'anthropic' | 'openrouter' = 'runner:claude') => ({ model, route });

describe('versionTuple', () => {
  it('reads the numeric tokens of the undated base', () => {
    expect(versionTuple('claude-sonnet-5')).toEqual([5]);
    expect(versionTuple('claude-sonnet-5-1')).toEqual([5, 1]);
    expect(versionTuple('claude-sonnet-4-5')).toEqual([4, 5]);
    expect(versionTuple('claude-haiku-4-5-20251001')).toEqual([4, 5]);
    expect(versionTuple('openai/gpt-5.3-codex')).toEqual([5, 3]);
    expect(versionTuple('qwen/qwen3-coder')).toEqual([3]);
    expect(versionTuple('meta-llama/llama-70b')).toEqual([]);
    expect(versionTuple('claude-sonnet')).toEqual([]);
  });

  it('compares lexicographically with zero padding', () => {
    expect(compareVersions([5], [5, 0])).toBe(0);
    expect(compareVersions([5], [5, 1])).toBe(-1);
    expect(compareVersions([5], [4, 5])).toBe(1);
  });
});

describe('findSuccessor', () => {
  it('sonnet-5 → sonnet-5-1', () => {
    const catalog = [entry('claude-sonnet-5'), entry('claude-sonnet-5-1', { created: T0 + 60 * DAY })];
    expect(findSuccessor({ arm: arm('claude-sonnet-5'), tier: 'standard', catalog, now: NOW })?.id).toBe('claude-sonnet-5-1');
  });

  it('4-5 → 5', () => {
    const catalog = [entry('claude-sonnet-4-5'), entry('claude-sonnet-5', { created: T0 + 60 * DAY })];
    expect(findSuccessor({ arm: arm('claude-sonnet-4-5'), tier: 'standard', catalog, now: NOW })?.id).toBe('claude-sonnet-5');
  });

  it('no succession for an unversioned id, even with a newer date', () => {
    const catalog = [entry('claude-sonnet'), entry('claude-sonnet-5', { created: T0 + 60 * DAY })];
    expect(findSuccessor({ arm: arm('claude-sonnet'), tier: 'standard', catalog, now: NOW })).toBeNull();
  });

  it('a higher version released the same day is not a successor', () => {
    const catalog = [entry('claude-sonnet-5'), entry('claude-sonnet-5-1', { created: T0 + 60 })];
    expect(findSuccessor({ arm: arm('claude-sonnet-5'), tier: 'standard', catalog, now: NOW })).toBeNull();
  });

  it('skips previews, deprecated models and dated snapshots of the same base', () => {
    const later = T0 + 60 * DAY;
    const catalog = [
      entry('claude-sonnet-5'),
      entry('claude-sonnet-5-1-preview', { created: later }),
      entry('claude-sonnet-5-2', { created: later, expiresAt: NOW + 10 * DAY }),
      entry('claude-sonnet-5-20270101', { created: later }),
    ];
    expect(findSuccessor({ arm: arm('claude-sonnet-5'), tier: 'standard', catalog, now: NOW })).toBeNull();
  });

  it('skips a successor out of the tier price band, a short context, or another family', () => {
    const later = T0 + 60 * DAY;
    const out = (c: CatalogEntry[]) => findSuccessor({ arm: arm('claude-sonnet-5'), tier: 'standard', catalog: [entry('claude-sonnet-5'), ...c], now: NOW });
    expect(out([entry('claude-sonnet-5-1', { created: later, input: 5 })])).toBeNull();
    expect(out([entry('claude-sonnet-5-1', { created: later, contextLength: 100_000 })])).toBeNull();
    expect(out([entry('claude-sonnet-mini-6', { created: later })])).toBeNull();
    expect(out([entry('claude-opus-6', { created: later })])).toBeNull();
  });

  it('an Anthropic route only takes an Anthropic-served successor', () => {
    const catalog = [entry('claude-sonnet-5'), entry('claude-sonnet-5-1', { created: T0 + 60 * DAY, provider: 'other' })];
    expect(findSuccessor({ arm: arm('claude-sonnet-5', 'anthropic'), tier: 'standard', catalog, now: NOW })).toBeNull();
    expect(findSuccessor({ arm: arm('claude-sonnet-5', 'openrouter'), tier: 'standard', catalog, now: NOW })?.id).toBe('claude-sonnet-5-1');
  });

  it('ties: highest version, then newest day, then popularity, then shorter id', () => {
    const d = (n: number) => T0 + n * DAY;
    const base = entry('claude-sonnet-5');
    const pick = (c: CatalogEntry[], pop?: (id: string) => number | null) =>
      findSuccessor({ arm: arm('claude-sonnet-5'), tier: 'standard', catalog: [base, ...c], now: NOW, popularity: pop })?.id;
    expect(pick([entry('claude-sonnet-5-1', { created: d(90) }), entry('claude-sonnet-5-2', { created: d(60) })])).toBe('claude-sonnet-5-2');
    expect(pick([entry('claude-sonnet-6', { created: d(60) }), entry('claude-sonnet-6-0', { created: d(90) })])).toBe('claude-sonnet-6-0');
    expect(pick(
      [entry('claude-sonnet-6', { created: d(60) }), entry('claude-sonnet-6-0', { created: d(60) })],
      id => (id === 'claude-sonnet-6-0' ? 1 : 0.5),
    )).toBe('claude-sonnet-6-0');
    expect(pick([entry('claude-sonnet-6', { created: d(60) }), entry('claude-sonnet-6-0', { created: d(60) })])).toBe('claude-sonnet-6');
  });
});

describe('decayMultiplier', () => {
  it('halves every 14 days', () => {
    expect(decayMultiplier(0)).toBe(1);
    expect(decayMultiplier(14)).toBeCloseTo(0.5, 9);
    expect(decayMultiplier(28)).toBeCloseTo(0.25, 9);
    expect(decayMultiplier(-3)).toBe(1);
    // About day 47 it falls below 0.1.
    expect(decayMultiplier(46)).toBeGreaterThan(0.1);
    expect(decayMultiplier(47)).toBeLessThan(0.1);
  });
});
