/**
 * Regression tests for the claude-opus-5 + xhigh/max thinking guard.
 *
 * claude-opus-5 at xhigh or max effort requires thinking to be enabled (or
 * absent). Passing { type: "disabled" } at those effort levels causes a 400.
 * The guard in workers.ts strips the disabled override, letting the SDK omit
 * the thinking parameter entirely so the API decides the default.
 */

import { describe, test, expect } from 'bun:test';

type ThinkingConfig = { type: 'enabled' | 'disabled' | 'adaptive' } | undefined;
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;

/** Mirrors the guard logic from workers.ts verbatim. */
function resolveEffectiveThinking(
  model: string,
  configuredEffort: Effort,
  configuredThinking: ThinkingConfig,
): ThinkingConfig {
  const isOpus5HighEffort = /claude-opus-5/i.test(model || '')
    && (configuredEffort === 'xhigh' || configuredEffort === 'max');
  return (isOpus5HighEffort && (configuredThinking as any)?.type === 'disabled')
    ? undefined
    : configuredThinking;
}

describe('opus5 thinking guard', () => {
  test('strips disabled thinking for claude-opus-5 at xhigh effort', () => {
    const result = resolveEffectiveThinking('claude-opus-5', 'xhigh', { type: 'disabled' });
    expect(result).toBeUndefined();
  });

  test('strips disabled thinking for claude-opus-5 at max effort', () => {
    const result = resolveEffectiveThinking('claude-opus-5', 'max', { type: 'disabled' });
    expect(result).toBeUndefined();
  });

  test('preserves adaptive thinking for claude-opus-5 at xhigh effort', () => {
    const result = resolveEffectiveThinking('claude-opus-5', 'xhigh', { type: 'adaptive' });
    expect(result).toEqual({ type: 'adaptive' });
  });

  test('preserves enabled thinking for claude-opus-5 at xhigh effort', () => {
    const result = resolveEffectiveThinking('claude-opus-5', 'xhigh', { type: 'enabled' });
    expect(result).toEqual({ type: 'enabled' });
  });

  test('preserves undefined thinking for claude-opus-5 at xhigh effort', () => {
    const result = resolveEffectiveThinking('claude-opus-5', 'xhigh', undefined);
    expect(result).toBeUndefined();
  });

  test('does NOT strip disabled thinking for claude-opus-5 at lower efforts', () => {
    expect(resolveEffectiveThinking('claude-opus-5', 'high', { type: 'disabled' }))
      .toEqual({ type: 'disabled' });
    expect(resolveEffectiveThinking('claude-opus-5', 'medium', { type: 'disabled' }))
      .toEqual({ type: 'disabled' });
    expect(resolveEffectiveThinking('claude-opus-5', 'low', { type: 'disabled' }))
      .toEqual({ type: 'disabled' });
  });

  test('does NOT strip disabled thinking for non-opus-5 models at xhigh/max', () => {
    expect(resolveEffectiveThinking('claude-opus-4-8', 'xhigh', { type: 'disabled' }))
      .toEqual({ type: 'disabled' });
    expect(resolveEffectiveThinking('claude-fable-5', 'max', { type: 'disabled' }))
      .toEqual({ type: 'disabled' });
    expect(resolveEffectiveThinking('claude-sonnet-5', 'xhigh', { type: 'disabled' }))
      .toEqual({ type: 'disabled' });
  });

  test('does NOT strip when no effort is set (undefined)', () => {
    const result = resolveEffectiveThinking('claude-opus-5', undefined, { type: 'disabled' });
    expect(result).toEqual({ type: 'disabled' });
  });

  test('case-insensitive model ID matching', () => {
    const result = resolveEffectiveThinking('Claude-Opus-5', 'xhigh', { type: 'disabled' });
    expect(result).toBeUndefined();
  });
});
