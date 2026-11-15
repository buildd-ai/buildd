import { describe, expect, it } from 'bun:test';
import {
  WALL_FALLBACK_CHOICES,
  describeWallFallback,
  fallbackCapReached,
  heldForWall,
  isSubscriptionPinned,
  parseWallFallbackSetting,
  startOfUtcDay,
  validateWallFallbackInput,
  wallFallbackRoute,
  SUBSCRIPTION_PINNED_KEY,
} from '../wall-fallback';

describe('parseWallFallbackSetting', () => {
  it('reads null, junk and an unknown choice as wait with no cap', () => {
    for (const raw of [null, undefined, 'x', 42, { fallback: 'bogus' }]) {
      expect(parseWallFallbackSetting(raw)).toEqual({ fallback: 'wait', maxCostPerDayUsd: null });
    }
  });

  it('keeps a known choice and a positive cap', () => {
    expect(parseWallFallbackSetting({ fallback: 'anthropic', maxCostPerDayUsd: 25 }))
      .toEqual({ fallback: 'anthropic', maxCostPerDayUsd: 25 });
    expect(parseWallFallbackSetting({ fallback: 'openrouter', maxCostPerDayUsd: -1 }))
      .toEqual({ fallback: 'openrouter', maxCostPerDayUsd: null });
  });
});

describe('validateWallFallbackInput', () => {
  it('accepts every choice', () => {
    for (const c of WALL_FALLBACK_CHOICES) {
      const r = validateWallFallbackInput({ fallback: c });
      expect(r.ok).toBe(true);
    }
  });

  it('refuses an unknown choice and a bad cap', () => {
    expect(validateWallFallbackInput({ fallback: 'nope' }).ok).toBe(false);
    expect(validateWallFallbackInput({ fallback: 'anthropic', maxCostPerDayUsd: 0 }).ok).toBe(false);
    expect(validateWallFallbackInput({ fallback: 'anthropic', maxCostPerDayUsd: 'ten' }).ok).toBe(false);
    expect(validateWallFallbackInput({ fallback: 'anthropic', maxCostPerDayUsd: 1_000_001 }).ok).toBe(false);
  });

  it('accepts null as no cap and rounds to cents', () => {
    expect(validateWallFallbackInput({ fallback: 'anthropic', maxCostPerDayUsd: null }))
      .toEqual({ ok: true, setting: { fallback: 'anthropic', maxCostPerDayUsd: null } });
    expect(validateWallFallbackInput({ fallback: 'litellm', maxCostPerDayUsd: 12.345 }))
      .toEqual({ ok: true, setting: { fallback: 'litellm', maxCostPerDayUsd: 12.35 } });
  });
});

describe('heldForWall', () => {
  it('reserves the normal-route credential the fallback names, for a subscription account only', () => {
    expect(heldForWall({ fallback: 'anthropic', maxCostPerDayUsd: null }, 'oauth')).toBe('anthropic_api_key');
    expect(heldForWall({ fallback: 'endpoint', maxCostPerDayUsd: null }, 'oauth')).toBe('agent_endpoint');
    // OpenRouter and LiteLLM never reach an agent run without an endpoint row: nothing to reserve.
    expect(heldForWall({ fallback: 'openrouter', maxCostPerDayUsd: null }, 'oauth')).toBeNull();
    expect(heldForWall({ fallback: 'litellm', maxCostPerDayUsd: null }, 'oauth')).toBeNull();
    expect(heldForWall({ fallback: 'wait', maxCostPerDayUsd: null }, 'oauth')).toBeNull();
  });

  it('never holds anything back from an api account', () => {
    expect(heldForWall({ fallback: 'anthropic', maxCostPerDayUsd: null }, 'api')).toBeNull();
    expect(heldForWall({ fallback: 'endpoint', maxCostPerDayUsd: null }, 'api')).toBeNull();
  });
});

describe('wallFallbackRoute', () => {
  it('maps each choice to the model route it serves', () => {
    expect(wallFallbackRoute('anthropic')).toBe('anthropic_api_key');
    expect(wallFallbackRoute('openrouter')).toBe('agent_endpoint');
    expect(wallFallbackRoute('litellm')).toBe('agent_endpoint');
    expect(wallFallbackRoute('endpoint')).toBe('agent_endpoint');
  });
});

describe('fallbackCapReached', () => {
  it('is never reached without a cap', () => {
    expect(fallbackCapReached({ fallback: 'anthropic', maxCostPerDayUsd: null }, 1e9)).toBe(false);
  });
  it('is reached at the cap', () => {
    expect(fallbackCapReached({ fallback: 'anthropic', maxCostPerDayUsd: 10 }, 9.99)).toBe(false);
    expect(fallbackCapReached({ fallback: 'anthropic', maxCostPerDayUsd: 10 }, 10)).toBe(true);
  });
});

describe('isSubscriptionPinned', () => {
  it('reads the context flag', () => {
    expect(isSubscriptionPinned({ [SUBSCRIPTION_PINNED_KEY]: true })).toBe(true);
    expect(isSubscriptionPinned({ [SUBSCRIPTION_PINNED_KEY]: 'yes' })).toBe(false);
    expect(isSubscriptionPinned(null)).toBe(false);
  });
});

describe('describeWallFallback', () => {
  it('names the login that hit the wall, what served the run and the cost', () => {
    const s = describeWallFallback({
      served: 'anthropic', label: "the team's Anthropic API key", wall: { scope: 'login', runner: 'mac-mini' }, at: '2026-11-14T10:00:00.000Z',
    }, 1.234);
    expect(s).toBe("Ran on the team's Anthropic API key: mac-mini's subscription login hit its usage limit. Cost $1.23.");
  });

  it('reads a pool wall and an unknown cost', () => {
    const s = describeWallFallback({
      served: 'openrouter', label: 'OpenRouter', wall: { scope: 'pool', runner: null }, at: '2026-11-14T10:00:00.000Z',
    }, null);
    expect(s).toBe("Ran on OpenRouter: the runner account's subscription login hit its usage limit.");
  });

  it('returns null for anything that is not a record', () => {
    expect(describeWallFallback(null, 1)).toBeNull();
    expect(describeWallFallback({ served: 'x' }, 1)).toBeNull();
  });
});

describe('startOfUtcDay', () => {
  it('is UTC midnight of the same day', () => {
    expect(startOfUtcDay(new Date('2026-11-14T23:59:00.000Z')).toISOString()).toBe('2026-11-14T00:00:00.000Z');
  });
});
