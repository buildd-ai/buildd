import { describe, it, expect } from 'bun:test';
import {
  parseLabeledJsonl,
  splitHeldOut,
  summarizeBenchmark,
  formatBenchmarkSummary,
} from '../decision-benchmark';

describe('parseLabeledJsonl', () => {
  it('reads labelled rows, keeps other fields, and skips junk', () => {
    const text = [
      '{"id":"a","label":"bug","title":"Crash on save"}',
      '',
      '// a comment',
      '{"label":"docs","title":"Write README"}',
      'not json',
      '{"title":"no label"}',
    ].join('\n');
    const { examples, skipped } = parseLabeledJsonl(text);
    expect(examples).toEqual([
      { id: 'a', label: 'bug', fields: { title: 'Crash on save' } },
      { id: 'line-4', label: 'docs', fields: { title: 'Write README' } },
    ]);
    expect(skipped).toBe(2);
  });
});

describe('splitHeldOut', () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}` }));

  it('is deterministic and roughly honours the fraction', () => {
    const a = splitHeldOut(items, { heldOutFraction: 0.3, seed: 's' });
    const b = splitHeldOut(items, { heldOutFraction: 0.3, seed: 's' });
    expect(a.heldOut.map(x => x.id)).toEqual(b.heldOut.map(x => x.id));
    expect(a.heldOut.length + a.train.length).toBe(1000);
    expect(a.heldOut.length).toBeGreaterThan(240);
    expect(a.heldOut.length).toBeLessThan(360);
  });

  it('never puts one example in both halves', () => {
    const { train, heldOut } = splitHeldOut(items);
    const trainIds = new Set(train.map(x => x.id));
    expect(heldOut.some(x => trainIds.has(x.id))).toBe(false);
  });

  it('reshuffles with a different seed', () => {
    const a = splitHeldOut(items, { seed: 'one' }).heldOut.map(x => x.id);
    const b = splitHeldOut(items, { seed: 'two' }).heldOut.map(x => x.id);
    expect(a).not.toEqual(b);
  });
});

describe('summarizeBenchmark', () => {
  const scored = [
    { id: '1', gold: 'bug', predicted: 'bug', confidence: 0.95, baseline: 'bug' },
    { id: '2', gold: 'bug', predicted: 'feature', confidence: 0.6, baseline: 'feature' },
    { id: '3', gold: 'docs', predicted: 'docs', confidence: 0.85, baseline: null },
    { id: '4', gold: 'docs', predicted: null, confidence: null, baseline: 'docs', error: 'timeout' },
  ];

  it('counts errors as wrong in overall accuracy', () => {
    const s = summarizeBenchmark(scored, [0, 0.9]);
    expect(s.total).toBe(4);
    expect(s.answered).toBe(3);
    expect(s.errors).toBe(1);
    expect(s.accuracy).toBe(0.5);
    expect(s.baselineAccuracy).toBe(0.5);
  });

  it('reports coverage and accuracy at each threshold', () => {
    const s = summarizeBenchmark(scored, [0, 0.8, 0.9, 0.99]);
    expect(s.thresholds[0]).toEqual({ threshold: 0, covered: 3, coverage: 0.75, accuracy: 2 / 3 });
    expect(s.thresholds[1]).toEqual({ threshold: 0.8, covered: 2, coverage: 0.5, accuracy: 1 });
    expect(s.thresholds[2]).toEqual({ threshold: 0.9, covered: 1, coverage: 0.25, accuracy: 1 });
    expect(s.thresholds[3]).toEqual({ threshold: 0.99, covered: 0, coverage: 0, accuracy: null });
  });

  it('builds per-label precision/recall and a confusion matrix', () => {
    const s = summarizeBenchmark(scored);
    expect(s.perLabel.bug).toEqual({ gold: 2, predicted: 1, correct: 1, precision: 1, recall: 0.5 });
    expect(s.perLabel.feature).toEqual({ gold: 0, predicted: 1, correct: 0, precision: 0, recall: null });
    expect(s.confusion.bug).toEqual({ bug: 1, feature: 1 });
    expect(s.confusion.docs).toEqual({ docs: 1, '(error)': 1 });
  });

  it('formats without throwing', () => {
    const out = formatBenchmarkSummary('held-out', summarizeBenchmark(scored));
    expect(out).toContain('held-out');
    expect(out).toContain('baseline');
  });
});
