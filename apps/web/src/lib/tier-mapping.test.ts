import { describe, expect, it } from 'bun:test';
import {
  TIER_PROVIDER_OPTIONS,
  providerForModel,
  tierBandLabel,
  tierSourceState,
  tierSuggestions,
  tierUsedBy,
  suggestionFor,
} from './tier-mapping';

describe('tierUsedBy', () => {
  it('says which surfaces can run a tier, from its provider', () => {
    expect(tierUsedBy('anthropic')).toBe('agent runs, chat');
    expect(tierUsedBy('openrouter')).toBe('agent runs, chat');
    // A Codex seat only signs in a runner; an OpenAI API key only serves chat.
    expect(tierUsedBy('openai-codex')).toBe('agent runs only');
    expect(tierUsedBy('openai')).toBe('chat only');
  });
});

describe('suggestionFor', () => {
  it('picks the catalog note for one tier, newer before missing', () => {
    const list = [
      { tier: 'standard', kind: 'missing' as const, model: 'a' },
      { tier: 'standard', kind: 'newer' as const, model: 'a', newer: 'b' },
      { tier: 'budget', kind: 'missing' as const, model: 'c' },
    ];
    expect(suggestionFor(list, 'standard')).toEqual({ tier: 'standard', kind: 'newer', model: 'a', newer: 'b' });
    expect(suggestionFor(list, 'budget')?.kind).toBe('missing');
    expect(suggestionFor(list, 'premium')).toBeNull();
  });
});

describe('TIER_PROVIDER_OPTIONS', () => {
  it('offers only providers the registry accepts', () => {
    expect(TIER_PROVIDER_OPTIONS.map((p) => p.id)).toEqual(['anthropic', 'openrouter', 'openai', 'openai-codex']);
  });
});

describe('tierSourceState', () => {
  it('calls a registry row pinned: buildd will not move it', () => {
    expect(tierSourceState('team').pinned).toBe(true);
    expect(tierSourceState('workspace').pinned).toBe(true);
  });

  it('calls a catalog pick auto: it follows the newest model in the price band', () => {
    expect(tierSourceState('catalog')).toMatchObject({ pinned: false, label: 'auto' });
    expect(tierSourceState('default')).toMatchObject({ pinned: false, label: 'auto' });
    expect(tierSourceState(undefined).pinned).toBe(false);
  });
});

describe('providerForModel', () => {
  it('reads the provider an existing row was saved under', () => {
    expect(providerForModel('openrouter')).toBe('openrouter');
    expect(providerForModel('bogus')).toBe('anthropic');
  });
});

describe('tierBandLabel', () => {
  it('describes the price band the auto pick stays inside', () => {
    expect(tierBandLabel('standard')).toBe('$1.50 to $4 input per MTok');
    expect(tierBandLabel('budget')).toBe('under $1.50 input per MTok');
  });
});

describe('tierSuggestions', () => {
  it('turns catalog audit notes into read-only suggestions, pinned tiers only', () => {
    const out = tierSuggestions({
      checked: true,
      superseded: [{ tier: 'standard', model: 'claude-sonnet-4-6', newer: 'claude-sonnet-5' }],
      unknown: [{ tier: 'budget', model: 'claude-gone-1' }],
    }, { catalogComplete: true });
    expect(out).toEqual([
      { tier: 'standard', kind: 'newer', model: 'claude-sonnet-4-6', newer: 'claude-sonnet-5' },
      { tier: 'budget', kind: 'missing', model: 'claude-gone-1' },
    ]);
  });

  it('drops "missing" notes when the catalog is incomplete: absence proves nothing', () => {
    const out = tierSuggestions({ checked: true, superseded: [], unknown: [{ tier: 'budget', model: 'x' }] }, { catalogComplete: false });
    expect(out).toEqual([]);
  });

  it('returns nothing when the catalog was not checked', () => {
    expect(tierSuggestions({ checked: false, superseded: [{ tier: 'standard', model: 'a', newer: 'b' }], unknown: [] })).toEqual([]);
    expect(tierSuggestions(undefined)).toEqual([]);
  });
});
