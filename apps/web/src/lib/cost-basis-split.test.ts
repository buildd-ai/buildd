import { describe, expect, it } from 'bun:test';
import { addToSplit, basisOfRow, emptySplit, splitTotal } from './cost-basis-split';

describe('basisOfRow', () => {
  it('keeps a recorded basis', () => {
    expect(basisOfRow('real', { costUsd: 1 })).toBe('real');
    expect(basisOfRow('virtual', { inputTokens: 5 })).toBe('virtual');
  });

  it('a row with no basis and no usage contributes nothing', () => {
    expect(basisOfRow(null, { costUsd: 0, inputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(basisOfRow(undefined, {})).toBeNull();
  });

  it('a row with usage but no basis is unknown, never folded into real or virtual', () => {
    expect(basisOfRow(null, { costUsd: 2 })).toBe('unknown');
    expect(basisOfRow(null, { outputTokens: 1 })).toBe('unknown');
  });

  it('an unrecognised stored value is unknown', () => {
    expect(basisOfRow('oauth' as any, { costUsd: 1 })).toBe('unknown');
  });
});

describe('addToSplit', () => {
  it('sums tokens, cost and workers per basis', () => {
    const s = emptySplit();
    addToSplit(s, 'real', { inputTokens: 10, outputTokens: 2, costUsd: 2 });
    addToSplit(s, 'virtual', { inputTokens: 100, outputTokens: 20, costUsd: 5 });
    addToSplit(s, 'virtual', { inputTokens: 1, outputTokens: 0, costUsd: '0.5' });
    expect(s.real).toEqual({ workers: 1, inputTokens: 10, outputTokens: 2, costUsd: 2 });
    expect(s.virtual).toEqual({ workers: 2, inputTokens: 101, outputTokens: 20, costUsd: 5.5 });
    expect(s.unknown.workers).toBe(0);
    expect(splitTotal(s).costUsd).toBeCloseTo(7.5, 9);
  });
});
