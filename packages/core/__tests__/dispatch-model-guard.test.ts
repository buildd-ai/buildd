import { describe, it, expect } from 'bun:test';
import {
  checkDispatchModel,
  guardDispatchModel,
  describeDispatchModelRejection,
  tierForModelId,
} from '../dispatch-model-guard';
import { TIER_DEFAULTS } from '../model-tier-defaults';
import type { CatalogEntry } from '../model-catalog';

const DAY = 86_400;
const D = (n: number) => 1_790_000_000 + n * DAY;

function entry(id: string, created: number, input = 2): CatalogEntry {
  return {
    id, canonicalId: null, openRouterId: `anthropic/${id}`, provider: 'anthropic', displayName: id,
    contextLength: 1_000_000, created, input, output: input * 5, cacheRead: input * 0.1, cacheWrite: input * 1.25,
  };
}

// Sonnet 5.5 has a recorded CLI floor; a hypothetical Sonnet 6 release
// after it still needs its own verified floor before dispatch.
const CATALOG: CatalogEntry[] = [
  entry('claude-sonnet-5', D(0)),
  entry('claude-opus-5', D(1), 5),
  entry('claude-opus-5-5', D(10), 4),
  entry('claude-sonnet-5-5', D(15)),
  entry('claude-sonnet-6', D(20)),
  entry('claude-haiku-4-5', D(-100), 1),
];

describe('checkDispatchModel', () => {
  it('refuses a release newer than every recorded CLI floor', () => {
    expect(checkDispatchModel('claude-sonnet-6', CATALOG)).toEqual({ ok: false, reason: 'newer_than_floor_table' });
  });

  it('refuses a Claude id the healthy catalog does not list', () => {
    expect(checkDispatchModel('claude-sonnet-55', CATALOG)).toEqual({ ok: false, reason: 'not_in_catalog' });
  });

  it('accepts a recognised release, a dated snapshot of one, and the recorded-floor models', () => {
    expect(checkDispatchModel('claude-sonnet-5', CATALOG).ok).toBe(true);
    expect(checkDispatchModel('claude-haiku-4-5-20251001', CATALOG).ok).toBe(true);
    expect(checkDispatchModel('claude-opus-5-5', CATALOG).ok).toBe(true);
    expect(checkDispatchModel('claude-sonnet-5-5', CATALOG).ok).toBe(true);
  });

  it('accepts the code-level tier defaults even if the catalog has not heard of them', () => {
    for (const t of Object.values(TIER_DEFAULTS)) expect(checkDispatchModel(t.model, [entry('claude-x', D(0))]).ok).toBe(true);
  });

  it('fails open on an empty catalog (we learned nothing)', () => {
    expect(checkDispatchModel('claude-sonnet-5-5', []).ok).toBe(true);
  });

  it('only judges Claude ids: aliases and other vendors pass through', () => {
    for (const m of ['sonnet', 'opus', 'haiku', 'gpt-5.3-codex', 'anthropic/claude-sonnet-5.5', 'qwen/qwen3-coder']) {
      expect(checkDispatchModel(m, CATALOG).ok).toBe(true);
    }
  });

  it('does not judge a recorded CLI floor: that stays the runner_capability deferral', () => {
    expect(checkDispatchModel('claude-fable-5-1', CATALOG).ok).toBe(true);
  });
});

describe('guardDispatchModel', () => {
  it('keeps a valid model untouched', () => {
    const g = guardDispatchModel({
      resolved: 'claude-sonnet-5', source: 'tier_row', tier: 'standard', fallbacks: [], catalog: CATALOG,
    });
    expect(g).toEqual({ model: 'claude-sonnet-5', source: 'tier_row', rejection: null });
  });

  it('falls back to the tier entry and names the rejected id and where it came from', () => {
    const g = guardDispatchModel({
      resolved: 'claude-sonnet-6', source: 'tier_pool_arm', tier: 'standard',
      fallbacks: [{ model: 'claude-sonnet-5', source: 'tier_row' }], catalog: CATALOG,
    });
    expect(g.model).toBe('claude-sonnet-5');
    expect(g.source).toBe('tier_row');
    expect(g.rejection).toEqual({
      rejected: 'claude-sonnet-6', reason: 'newer_than_floor_table', source: 'tier_pool_arm', fallback: 'claude-sonnet-5',
    });
    expect(describeDispatchModelRejection(g.rejection!)).toContain('"claude-sonnet-6" from tier_pool_arm');
  });

  it('skips a tier entry that is itself bad and lands on the tier default', () => {
    const g = guardDispatchModel({
      resolved: 'claude-sonnet-6', source: 'tier_row', tier: 'standard',
      fallbacks: [{ model: 'claude-sonnet-6', source: 'tier_row' }], catalog: CATALOG,
    });
    expect(g.model).toBe(TIER_DEFAULTS.standard.model);
    expect(g.source).toBe('tier_default');
    expect(g.rejection?.fallback).toBe(TIER_DEFAULTS.standard.model);
  });

  it('with no fallback at all, serves the tier default', () => {
    const g = guardDispatchModel({
      resolved: 'claude-opus-5-5-typo', source: 'pin', tier: 'premium', fallbacks: [], catalog: CATALOG,
    });
    expect(g.model).toBe(TIER_DEFAULTS.premium.model);
    expect(g.rejection?.reason).toBe('not_in_catalog');
  });
});

describe('tierForModelId', () => {
  it('maps a model family to its tier', () => {
    expect(tierForModelId('claude-fable-5-1')).toBe('premium-plus');
    expect(tierForModelId('claude-opus-5-5')).toBe('premium');
    expect(tierForModelId('claude-haiku-4-5')).toBe('budget');
    expect(tierForModelId('claude-sonnet-5-5')).toBe('standard');
  });
});
