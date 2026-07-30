import { describe, expect, test } from 'bun:test';
import { aggregateUsage, extractResultUsage } from '../../src/usage-aggregate';

describe('extractResultUsage (SDK result message → totals)', () => {
  test('prefers the per-model breakdown when the SDK provides it', () => {
    const usage = extractResultUsage({
      usage: {
        byModel: {
          'claude-opus-4-6': { inputTokens: 1_000, cacheReadInputTokens: 9_000, outputTokens: 500 },
        },
      },
    });
    expect(usage).toEqual({ inputTokens: 10_000, outputTokens: 500 });
  });

  // The regression this whole change exists for: on seat-based (OAuth) auth the
  // SDK reports top-level usage but no `byModel` map, so reading only byModel
  // threw the numbers away and every OAuth worker persisted 0 tokens.
  test('falls back to top-level usage totals when byModel is absent', () => {
    const usage = extractResultUsage({
      usage: {
        input_tokens: 1_200,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 800,
        output_tokens: 3_400,
      },
    });
    expect(usage).toEqual({ inputTokens: 42_000, outputTokens: 3_400 });
  });

  test('accepts camelCase top-level usage too (SDK version drift)', () => {
    const usage = extractResultUsage({
      usage: { inputTokens: 100, cacheReadInputTokens: 50, outputTokens: 25 },
    });
    expect(usage).toEqual({ inputTokens: 150, outputTokens: 25 });
  });

  test('an empty byModel map does not mask the top-level totals', () => {
    const usage = extractResultUsage({
      usage: { byModel: {}, input_tokens: 700, output_tokens: 80 },
    });
    expect(usage).toEqual({ inputTokens: 700, outputTokens: 80 });
  });

  test('returns null when the SDK reported nothing usable', () => {
    expect(extractResultUsage(undefined)).toBeNull();
    expect(extractResultUsage({})).toBeNull();
    expect(extractResultUsage({ usage: {} })).toBeNull();
    expect(extractResultUsage({ usage: { byModel: {}, input_tokens: 0, output_tokens: 0 } })).toBeNull();
  });
});

describe('aggregateUsage (result metadata + per-turn tally)', () => {
  test('uses result metadata when it carries totals', () => {
    const usage = aggregateUsage(
      { modelUsage: { m: { inputTokens: 10, cacheReadInputTokens: 0, outputTokens: 2 } } } as any,
      { inputTokens: 999, outputTokens: 999 },
    );
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  test('uses the totalUsage the result carried when there is no per-model map', () => {
    const usage = aggregateUsage(
      { modelUsage: {}, totalUsage: { inputTokens: 5_000, outputTokens: 600 } } as any,
      { inputTokens: 1, outputTokens: 1 },
    );
    expect(usage).toEqual({ inputTokens: 5_000, outputTokens: 600 });
  });

  test('falls back to the per-turn tally when the result carried nothing', () => {
    // Assistant-message usage is always populated, including on OAuth, so this
    // is the last-resort path that guarantees a non-zero report.
    const usage = aggregateUsage({ modelUsage: {} } as any, { inputTokens: 8_000, outputTokens: 900 });
    expect(usage).toEqual({ inputTokens: 8_000, outputTokens: 900 });
  });

  test('returns null when no source has anything — caller omits the fields', () => {
    expect(aggregateUsage(undefined, { inputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(aggregateUsage({ modelUsage: {} } as any, { inputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});
