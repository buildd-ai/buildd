import { describe, expect, it } from 'bun:test';
import {
  TIER_PROVIDER_OPTIONS,
  modelOptionsFor,
  providerForModel,
  tierBandLabel,
  tierSourceState,
  tierSuggestions,
} from './tier-mapping';

// Illustrative catalog; ids mirror the public OpenRouter shape.
const MODELS = [
  { id: 'claude-opus-5', displayName: 'claude-opus-5 (premium)', provider: 'anthropic', tier: 'premium' as const, openRouterId: 'anthropic/claude-opus-5', inputPrice: 5, outputPrice: 25 },
  { id: 'claude-sonnet-5', displayName: 'Anthropic: Claude Sonnet 5', provider: 'anthropic', openRouterId: 'anthropic/claude-sonnet-5', inputPrice: 2, outputPrice: 10 },
  { id: 'claude-sonnet-5-20260630', displayName: 'Claude Sonnet 5', provider: 'anthropic' },
  { id: 'gpt-5.6-terra', displayName: 'OpenAI: GPT-5.6 Terra', provider: 'openai', openRouterId: 'openai/gpt-5.6-terra', inputPrice: 1.25, outputPrice: 10 },
  { id: 'qwen3-coder', displayName: 'Qwen: Qwen3 Coder', provider: 'other', openRouterId: 'qwen/qwen3-coder', inputPrice: 0.3, outputPrice: 1.2 },
];

describe('TIER_PROVIDER_OPTIONS', () => {
  it('offers only providers the registry accepts', () => {
    expect(TIER_PROVIDER_OPTIONS.map((p) => p.id)).toEqual(['anthropic', 'openrouter', 'openai-codex']);
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

describe('modelOptionsFor', () => {
  it('anthropic lists native Anthropic ids only', () => {
    const ids = modelOptionsFor('anthropic', MODELS).map((o) => o.value);
    expect(ids).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-5-20260630']);
  });

  it('openrouter lists every public entry by its OpenRouter id', () => {
    const ids = modelOptionsFor('openrouter', MODELS).map((o) => o.value);
    expect(ids).toContain('qwen/qwen3-coder');
    expect(ids).toContain('anthropic/claude-sonnet-5');
    expect(ids).not.toContain('claude-sonnet-5-20260630'); // no OpenRouter id
  });

  it('openai-codex lists OpenAI models by native id', () => {
    expect(modelOptionsFor('openai-codex', MODELS).map((o) => o.value)).toEqual(['gpt-5.6-terra']);
  });

  it('keeps the current model in the list even when the catalog lacks it', () => {
    const opts = modelOptionsFor('anthropic', MODELS, 'claude-retired-1');
    expect(opts[0]).toMatchObject({ value: 'claude-retired-1' });
    expect(opts[0].label).toMatch(/not in catalog/);
  });

  it('shows the input and output price when known', () => {
    const qwen = modelOptionsFor('openrouter', MODELS).find((o) => o.value === 'qwen/qwen3-coder')!;
    expect(qwen.price).toBe('$0.30 / $1.20');
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
