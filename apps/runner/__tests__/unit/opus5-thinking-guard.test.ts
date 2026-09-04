/**
 * Regression tests for the claude-opus-5 + xhigh/max thinking guard.
 *
 * claude-opus-5 at xhigh or max effort requires thinking to be enabled (or
 * absent). Passing { type: "disabled" } at those effort levels causes a 400.
 * The guard strips the disabled override so the API uses its own default.
 */

import { describe, test, expect } from 'bun:test';
import { resolveEffectiveThinking, requiresThinkingEnabled } from '@buildd/core/model-aliases';

describe('requiresThinkingEnabled', () => {
  test('returns true for claude-opus-5', () => {
    expect(requiresThinkingEnabled('claude-opus-5')).toBe(true);
  });

  test('returns false for claude-opus-4-8', () => {
    expect(requiresThinkingEnabled('claude-opus-4-8')).toBe(false);
  });

  test('returns false for claude-sonnet-4-6', () => {
    expect(requiresThinkingEnabled('claude-sonnet-4-6')).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(requiresThinkingEnabled('Claude-Opus-5')).toBe(true);
  });
});

describe('resolveEffectiveThinking', () => {
  test('strips disabled thinking for claude-opus-5 at xhigh effort', () => {
    expect(resolveEffectiveThinking('claude-opus-5', 'xhigh', { type: 'disabled' })).toBeUndefined();
  });

  test('strips disabled thinking for claude-opus-5 at max effort', () => {
    expect(resolveEffectiveThinking('claude-opus-5', 'max', { type: 'disabled' })).toBeUndefined();
  });

  test('preserves adaptive thinking for claude-opus-5 at xhigh effort', () => {
    expect(resolveEffectiveThinking('claude-opus-5', 'xhigh', { type: 'adaptive' })).toEqual({ type: 'adaptive' });
  });

  test('preserves enabled thinking for claude-opus-5 at xhigh effort', () => {
    expect(resolveEffectiveThinking('claude-opus-5', 'xhigh', { type: 'enabled' })).toEqual({ type: 'enabled' });
  });

  test('preserves undefined thinking for claude-opus-5 at xhigh effort', () => {
    expect(resolveEffectiveThinking('claude-opus-5', 'xhigh', undefined)).toBeUndefined();
  });

  test('does NOT strip disabled thinking for claude-opus-5 at lower efforts', () => {
    expect(resolveEffectiveThinking('claude-opus-5', 'high', { type: 'disabled' })).toEqual({ type: 'disabled' });
    expect(resolveEffectiveThinking('claude-opus-5', 'medium', { type: 'disabled' })).toEqual({ type: 'disabled' });
    expect(resolveEffectiveThinking('claude-opus-5', 'low', { type: 'disabled' })).toEqual({ type: 'disabled' });
  });

  test('does NOT strip disabled thinking for claude-opus-4-8 at any effort', () => {
    expect(resolveEffectiveThinking('claude-opus-4-8', 'xhigh', { type: 'disabled' })).toEqual({ type: 'disabled' });
    expect(resolveEffectiveThinking('claude-opus-4-8', 'max', { type: 'disabled' })).toEqual({ type: 'disabled' });
  });

  test('does NOT strip disabled thinking for non-opus models at xhigh effort', () => {
    expect(resolveEffectiveThinking('claude-sonnet-4-6', 'xhigh', { type: 'disabled' })).toEqual({ type: 'disabled' });
  });
});

/**
 * Fable / Mythos reject `{ type: "disabled" }` at EVERY effort level, not just
 * xhigh/max — thinking is always on and the parameter must simply be omitted.
 * This became load-bearing when `premium-plus` shipped pointing at Fable: a
 * workspace with thinking disabled would 400 on every premium-plus task.
 */
describe('models that reject disabled thinking outright', () => {
  test('strips disabled thinking for fable at ANY effort, including low', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(resolveEffectiveThinking('claude-fable-5-1', effort, { type: 'disabled' })).toBeUndefined();
    }
  });

  test('strips disabled thinking with no effort configured at all', () => {
    expect(resolveEffectiveThinking('claude-fable-5-1', undefined, { type: 'disabled' })).toBeUndefined();
  });

  test('covers fable 5 and the mythos counterparts', () => {
    expect(resolveEffectiveThinking('claude-fable-5', 'low', { type: 'disabled' })).toBeUndefined();
    expect(resolveEffectiveThinking('claude-mythos-5-1', 'low', { type: 'disabled' })).toBeUndefined();
  });

  test('preserves adaptive thinking on fable — only "disabled" is rejected', () => {
    expect(resolveEffectiveThinking('claude-fable-5-1', 'max', { type: 'adaptive' })).toEqual({ type: 'adaptive' });
    expect(resolveEffectiveThinking('claude-fable-5-1', 'max', undefined)).toBeUndefined();
  });

  test('requiresThinkingEnabled reports fable too', () => {
    expect(requiresThinkingEnabled('claude-fable-5-1')).toBe(true);
    expect(requiresThinkingEnabled('claude-mythos-5-1')).toBe(true);
    expect(requiresThinkingEnabled('claude-sonnet-5')).toBe(false);
  });
});
