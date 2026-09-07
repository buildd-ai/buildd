import { describe, it, expect } from 'bun:test';
import { buildSubagentDelegationPanel, type SubagentTimeRow } from './subagent-time';
import type { DerivedMetric } from '@buildd/core/derived-metric';

const CAPTURED_SINCE = '2026-08-15';

const row = (over: Partial<SubagentTimeRow> = {}): SubagentTimeRow => ({
  startedAt: new Date('2026-09-01T00:00:00Z'),
  completedAt: new Date('2026-09-01T01:00:00Z'), // 1h wall clock
  backgroundAgentMs: 0,
  subagentSpansObserved: 0,
  spansLength: 0,
  ...over,
});

describe('buildSubagentDelegationPanel', () => {
  it('is unavailable with no rows and a window that does not predate capture', () => {
    const panel = buildSubagentDelegationPanel({
      rows: [],
      windowStart: new Date('2026-09-01T00:00:00Z'),
      rowLimit: 5000,
      capturedSince: CAPTURED_SINCE,
    });
    expect(panel.kind).toBe('unavailable');
    expect(panel.reason).toBe('no_scope');
    expect(panel.detail).not.toBeNull();
  });

  it('flags windowPredatesCapture independent of whether rows were found', () => {
    const panel = buildSubagentDelegationPanel({
      rows: [row()],
      windowStart: new Date('2026-07-01T00:00:00Z'), // before capture began
      rowLimit: 5000,
      capturedSince: CAPTURED_SINCE,
    });
    expect(panel.kind).toBe('value'); // a row was still supplied
    if (panel.kind === 'value') {
      expect(panel.value.windowPredatesCapture).toBe(true);
    }
  });

  it('excludes rows with no computable wall clock rather than treating them as zero', () => {
    const panel = buildSubagentDelegationPanel({
      rows: [row({ startedAt: null }), row({ completedAt: null })],
      windowStart: new Date('2026-09-01T00:00:00Z'),
      rowLimit: 5000,
      capturedSince: CAPTURED_SINCE,
    });
    expect(panel.kind).toBe('unavailable');
  });

  it('computes the median share of total effort spent in background subagents', () => {
    // Session A: 1h wall clock, 0ms background -> 0% share.
    // Session B: 1h wall clock, 1h background -> 50% share (background is
    // additional effort, not a slice of the 1h wall clock).
    const panel = buildSubagentDelegationPanel({
      rows: [
        row({ backgroundAgentMs: 0 }),
        row({ backgroundAgentMs: 60 * 60 * 1000 }),
      ],
      windowStart: new Date('2026-09-01T00:00:00Z'),
      rowLimit: 5000,
      capturedSince: CAPTURED_SINCE,
    });
    expect(panel.kind).toBe('value');
    if (panel.kind === 'value') {
      expect(panel.value.sessions).toBe(2);
      expect(panel.value.sessionsWithDelegation).toBe(1);
      expect(panel.value.medianSharePct).toBe(25); // median of [0, 0.5] = 0.25
    }
  });

  it('marks the result a floor when a session hit the runner span cap', () => {
    const panel = buildSubagentDelegationPanel({
      rows: [row({ subagentSpansObserved: 120, spansLength: 100 })],
      windowStart: new Date('2026-09-01T00:00:00Z'),
      rowLimit: 5000,
      capturedSince: CAPTURED_SINCE,
    });
    expect(panel.kind).toBe('value');
    if (panel.kind === 'value') {
      expect(panel.value.isFloor).toBe(true);
    }
  });

  it('does not mark a floor when observed count matches the persisted span length', () => {
    const panel = buildSubagentDelegationPanel({
      rows: [row({ subagentSpansObserved: 5, spansLength: 5 })],
      windowStart: new Date('2026-09-01T00:00:00Z'),
      rowLimit: 5000,
      capturedSince: CAPTURED_SINCE,
    });
    expect(panel.kind).toBe('value');
    if (panel.kind === 'value') {
      expect(panel.value.isFloor).toBe(false);
    }
  });

  it('flags truncated when the row cap was hit', () => {
    const panel = buildSubagentDelegationPanel({
      rows: [row(), row()],
      windowStart: new Date('2026-09-01T00:00:00Z'),
      rowLimit: 2,
      capturedSince: CAPTURED_SINCE,
    });
    expect(panel.kind).toBe('value');
    if (panel.kind === 'value') {
      expect(panel.value.truncated).toBe(true);
    }
  });

  it('a real zero (no delegation anywhere) is measured, not unavailable', () => {
    const panel = buildSubagentDelegationPanel({
      rows: [row(), row(), row()],
      windowStart: new Date('2026-09-01T00:00:00Z'),
      rowLimit: 5000,
      capturedSince: CAPTURED_SINCE,
    });
    expect(panel.kind).toBe('value');
    if (panel.kind === 'value') {
      expect(panel.value.medianSharePct).toBe(0);
      expect(panel.value.sessionsWithDelegation).toBe(0);
    }
  });
});
