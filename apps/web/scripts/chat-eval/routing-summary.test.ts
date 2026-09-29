import { describe, it, expect } from 'bun:test';
import { formatRoutingSummary, parseTimeoutMs, summarizeRouting } from './lib/routing-summary';

const rec = (outcome: string, latencyMs: number) => ({
  outcome, latencyMs, attempts: 1, questionCount: 3, workspaceCount: 0, answers: {},
}) as any;

describe('summarizeRouting', () => {
  it('counts outcomes by kind and reports latency percentiles', () => {
    const s = summarizeRouting([
      rec('decision', 300), rec('low_confidence', 500), rec('error:timeout', 900), rec('error:timeout', 901), rec('decision', 400),
    ]);
    expect(s.total).toBe(5);
    expect(s.outcomes).toEqual({ decision: 2, low_confidence: 1, 'error:timeout': 2 });
    expect(s.latencyMs).toEqual({ p50: 500, p90: 901, max: 901 });
    expect(formatRoutingSummary(s, 900)).toBe('routing at 900ms over 5: decision 2 (40%), error:timeout 2 (40%), low_confidence 1 (20%); latency p50 500ms, p90 901ms, max 901ms');
  });

  it('an empty set has no latency', () => {
    expect(summarizeRouting([])).toEqual({ total: 0, outcomes: {}, latencyMs: null });
  });
});

describe('parseTimeoutMs', () => {
  it('defaults when absent, accepts whole positive ms, refuses anything else', () => {
    expect(parseTimeoutMs(undefined, 8_000)).toBe(8_000);
    expect(parseTimeoutMs('900', 8_000)).toBe(900);
    expect(() => parseTimeoutMs('0.9s', 8_000)).toThrow('--timeout');
    expect(() => parseTimeoutMs('-1', 8_000)).toThrow();
  });
});
