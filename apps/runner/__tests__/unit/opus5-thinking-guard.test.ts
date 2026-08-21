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
