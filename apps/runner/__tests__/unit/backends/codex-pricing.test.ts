import { describe, test, expect, afterEach } from 'bun:test';
import { CodexBackend } from '../../../src/backends/codex-backend';
import { setCatalogPrices } from '@buildd/core/model-prices';
import { normalizeCatalog } from '@buildd/core/model-catalog';

/**
 * Codex cost math. Verified 2026-09-04 against OpenRouter's public catalog.
 *
 * The old cascade got three things wrong, all of which cost real money on the
 * OAuth path where the SDK reports $0 and these numbers ARE the spend figure:
 *  1. no 5.6 row at all, so the newest generation fell to the generic $1.25/$10
 *  2. a single mini/nano rate, though those price per generation ($0.05-$0.75)
 *  3. `-pro` treated as uniformly expensive, but on 5.6 pro costs the base rate
 */

// `priceForModel` is private; reach it the way the backend does internally.
const price = (id: string, env?: Record<string, string>) =>
  (new CodexBackend() as any).priceForModel(id, env) as {
    input: number;
    cachedInput: number;
    output: number;
  };

afterEach(() => setCatalogPrices([]));

describe('codex priceForModel — static fallback', () => {
  test('prices the 5.6 line per variant instead of the generic rate', () => {
    // The bug: with no 5.6 row, luna billed at $1.25/$10 — 6x input, 8x output.
    expect(price('gpt-5.6-luna').input).toBeCloseTo(0.2, 6);
    expect(price('gpt-5.6-luna').output).toBeCloseTo(1.2, 6);
    expect(price('gpt-5.6-sol').output).toBeCloseTo(10, 6);
    expect(price('gpt-5.6-terra').output).toBeCloseTo(12, 6);
  });

  test('a 5.6 -pro variant costs the BASE rate, not the 5.5-era pro rate', () => {
    // Ordering regression: a `pro` check ahead of the 5.6 check prices
    // gpt-5.6-luna-pro at $30/$180 — a 150x overstatement on input.
    expect(price('gpt-5.6-luna-pro').input).toBeCloseTo(0.2, 6);
    expect(price('gpt-5.6-terra-pro').output).toBeCloseTo(12, 6);
  });

  test('but -pro on 5.4/5.5 really is the expensive tier', () => {
    expect(price('gpt-5.5-pro').input).toBeCloseTo(30, 6);
    expect(price('gpt-5.4-pro').output).toBeCloseTo(180, 6);
    expect(price('gpt-5.2-pro').input).toBeCloseTo(21, 6);
  });

  test('mini/nano price per generation, not off one shared rate', () => {
    expect(price('gpt-5.4-mini').input).toBeCloseTo(0.75, 6);
    expect(price('gpt-5.4-nano').input).toBeCloseTo(0.2, 6);
    expect(price('gpt-5-mini').input).toBeCloseTo(0.25, 6);
    expect(price('gpt-5-nano').input).toBeCloseTo(0.05, 6);
  });

  test('prices the codex variants we actually dispatch', () => {
    // gpt-5.1-codex-mini is $0.25/$2 — the old shared mini rate said $0.75/$4.50.
    expect(price('gpt-5.1-codex-mini').input).toBeCloseTo(0.25, 6);
    expect(price('gpt-5.1-codex').input).toBeCloseTo(1.25, 6);
    expect(price('gpt-5.3-codex').input).toBeCloseTo(1.75, 6);
    expect(price('gpt-5.3-codex').output).toBeCloseTo(14, 6);
  });

  test('an unrecognized model still gets a non-zero rate', () => {
    // A zero would make real spend invisible to the budget gates.
    expect(price('gpt-9-unreleased').input).toBeGreaterThan(0);
  });
});

describe('codex priceForModel — live catalog', () => {
  test('the catalog wins over the static cascade', () => {
    setCatalogPrices(
      normalizeCatalog({
        data: [
          {
            id: 'openai/gpt-5.6-terra',
            name: 'GPT 5.6 Terra',
            created: 1_800_000_000,
            context_length: 1_050_000,
            architecture: { output_modalities: ['text'] },
            // Deliberately not the real price — proves the catalog is consulted.
            pricing: { prompt: '0.000009', completion: '0.000042', input_cache_read: '0.0000009' },
            supported_parameters: ['tools'],
          },
        ],
      }),
    );
    expect(price('gpt-5.6-terra').input).toBeCloseTo(9, 6);
    expect(price('gpt-5.6-terra').output).toBeCloseTo(42, 6);
    expect(price('gpt-5.6-terra').cachedInput).toBeCloseTo(0.9, 6);
  });

  test('a model missing from the catalog still uses the static cascade', () => {
    setCatalogPrices(
      normalizeCatalog({
        data: [
          {
            id: 'openai/gpt-5.6-terra',
            name: 'GPT 5.6 Terra',
            created: 1_800_000_000,
            context_length: 1_050_000,
            architecture: { output_modalities: ['text'] },
            pricing: { prompt: '0.000009', completion: '0.000042' },
            supported_parameters: ['tools'],
          },
        ],
      }),
    );
    expect(price('gpt-5.6-luna').input).toBeCloseTo(0.2, 6);
  });
});

describe('codex priceForModel — env override', () => {
  test('an explicit env triple still beats both sources', () => {
    // The pre-existing escape hatch for a price we have not shipped yet.
    const p = price('gpt-5.6-terra', {
      CODEX_INPUT_USD_PER_M_TOKENS: '1',
      CODEX_CACHED_INPUT_USD_PER_M_TOKENS: '0.1',
      CODEX_OUTPUT_USD_PER_M_TOKENS: '7',
    });
    expect(p.input).toBe(1);
    expect(p.output).toBe(7);
  });
});
