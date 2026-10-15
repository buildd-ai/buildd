import { describe, expect, test } from 'bun:test';
import { compactEstimateTokens, formatTaskEstimate, type TaskEstimatePayload, type TaskEstimateEvidence } from '@buildd/shared';

const evidence = (completedWork: number): TaskEstimateEvidence => ({
  cutoff: '2026-01-01T00:00:00.000Z',
  history: { total: completedWork, completedWork, eligible: completedWork, excluded: {} },
  neighbours: { retrieved: 0, used: 0, reason: 'no_similar_neighbours' },
  clusters: { available: 0, used: 0, reason: 'unmapped' }, unavailable: [],
});
const estimate = (over: Partial<TaskEstimatePayload> = {}): TaskEstimatePayload => ({
  estimatorVersion: 'test-v1', p50Minutes: 6.2, p80Minutes: 14.2,
  p50Tokens: 1_640_000, p80Tokens: 7_000_000, expectedRepairs: 0,
  explanation: { sources: [{ source: 'prior', n: 50, weight: 1 }], clusterLabel: null, priorWeight: 1,
    summary: '5m (5-15m), 1640k tokens; no history in this repo yet.' },
  calibration: 'unknown', ...over,
});

describe('canonical estimate display', () => {
  test('one range without a point estimate, token detail or stale generated summary in the headline', () => {
    const d = formatTaskEstimate(estimate());
    expect(d.headline).toBe('About 5–15 min');
    expect(d.breakdown).toContain(d.headline);
    expect(d.breakdown).toContain('1.64M–7M tokens');
    expect(d.breakdown).toContain('test-v1');
    expect(d.headline).not.toContain('tokens');
    expect(d.breakdown).not.toContain('1640k');
    expect(d.provenance).not.toContain('no history');
  });
  test('true cold start differs from existing history without matches', () => {
    const cold = estimate(); cold.explanation.evidence = evidence(0);
    const existing = estimate(); existing.explanation.evidence = evidence(80);
    expect(formatTaskEstimate(cold).provenance).toContain('builds history');
    expect(formatTaskEstimate(existing).provenance).toContain('limited comparable history');
    expect(formatTaskEstimate(existing).provenance).not.toContain('builds history');
  });
  test('sufficient calibrated local evidence uses local provenance', () => {
    const r = estimate({ calibration: 'passed' });
    r.explanation.sources = [{ source: 'neighbours', n: 12, weight: 1 }];
    r.explanation.priorWeight = 0;
    r.explanation.evidence = evidence(80);
    expect(formatTaskEstimate(r).provenance).toBe('Based on comparable tasks in this repo.');
    expect(formatTaskEstimate(r).indicative).toBe(false);
  });
  test('uncalibrated or sparse evidence never exposes minute precision', () => {
    const r = estimate({ p50Minutes: 7.6, p80Minutes: 8.1 });
    r.explanation.sources = [{ source: 'neighbours', n: 4, weight: 1 }]; r.explanation.priorWeight = 0;
    expect(formatTaskEstimate(r).headline).toBe('About 5–10 min');
    expect(formatTaskEstimate(r).indicative).toBe(true);
  });
  test('unavailable history is unknown, never cold start', () => {
    const r = estimate(); r.explanation.evidence = { ...evidence(0), history: null, unavailable: ['history'] };
    expect(formatTaskEstimate(r).provenance).toContain('unavailable');
    expect(formatTaskEstimate(r).provenance).not.toContain('builds history');
  });
  test('no sources, too few samples, invalid or uselessly wide ranges suppress numbers', () => {
    const none = estimate(); none.explanation.sources = [];
    const sparse = estimate(); sparse.explanation.sources[0].n = 1;
    for (const r of [none, sparse, estimate({ p50Minutes: NaN }), estimate({ p50Minutes: 5, p80Minutes: 600 })]) {
      expect(formatTaskEstimate(r).range).toBeNull();
      expect(formatTaskEstimate(r).headline).toBe('Estimate unavailable');
      expect(formatTaskEstimate(r).breakdown).not.toContain('tokens');
    }
  });
});

test('compact tokens promote rounded unit boundaries', () => {
  expect(compactEstimateTokens(999_999)).toBe('1M');
  expect(compactEstimateTokens(1_640_000)).toBe('1.64M');
});
