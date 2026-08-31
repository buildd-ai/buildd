/**
 * CBM health summary.
 *
 * The failure this page missed for weeks was "mounted, indexed, never queried" —
 * which reads as perfect health under any availability-only summary. These tests
 * pin the states that matter, using the shapes seen in production.
 */
import { describe, it, expect } from 'bun:test';
import { aggregateCbm, summarizeCbm, type CbmRow } from './cbm-insight';
import type { CbmMetrics } from '@buildd/core/db/schema';

const WINDOW_START = new Date('2026-08-31T00:00:00Z');

function row(cbm: Partial<CbmMetrics>, inputTokens = 1000): CbmRow {
  return {
    inputTokens,
    cbm: {
      outcome: 'enforced',
      toolCalls: {},
      totalCbmCalls: 0,
      readCount: 0,
      grepCount: 0,
      globCount: 0,
      ...cbm,
    } as CbmMetrics,
  };
}

function summarize(rows: CbmRow[]) {
  return summarizeCbm(aggregateCbm(rows, '7d', WINDOW_START));
}

describe('summarizeCbm — state', () => {
  it('reports "unused" when the graph is mounted, indexed, and never queried', () => {
    // Exactly what production looked like: enforced + boot ok + zero calls.
    const rows = Array.from({ length: 12 }, () =>
      row({ bootstrapResult: 'ok', readCount: 9, grepCount: 3 }));
    const s = summarize(rows);
    expect(s.state).toBe('unused');
    expect(s.adoptionRate).toBe(0);
    expect(s.totalGraphCalls).toBe(0);
    expect(s.zeroCallTasks).toBe(12);
    // The substitution story: what they did instead.
    expect(s.avgFileAccessOnActive).toBe(12);
  });

  it('reports "partial" when a minority of tasks query the graph', () => {
    const rows = [
      ...Array.from({ length: 8 }, () => row({ bootstrapResult: 'ok' })),
      ...Array.from({ length: 2 }, () =>
        row({ bootstrapResult: 'ok', toolCalls: { search_graph: 2 }, totalCbmCalls: 2 })),
    ];
    const s = summarize(rows);
    expect(s.state).toBe('partial');
    expect(s.adoptionRate).toBeCloseTo(0.2, 5);
  });

  it('reports "healthy" when most tasks query the graph', () => {
    const rows = Array.from({ length: 6 }, () =>
      row({ bootstrapResult: 'ok', toolCalls: { trace_path: 1 }, totalCbmCalls: 1 }));
    expect(summarize(rows).state).toBe('healthy');
  });

  it('reports "unavailable" when CBM was mounted on nothing', () => {
    const rows = Array.from({ length: 4 }, () =>
      row({ outcome: 'disabled', disableReason: 'binary_absent' }));
    const s = summarize(rows);
    expect(s.state).toBe('unavailable');
    expect(s.binaryAbsent).toBe(4);
  });

  it('reports "no_data" rather than 0% when nothing is tracked', () => {
    const s = summarize([]);
    expect(s.state).toBe('no_data');
    // null, not 0 — "we never recorded it" must not render as "adoption is zero".
    expect(s.adoptionRate).toBeNull();
    expect(s.avgGraphCallsOnActive).toBeNull();
  });
});

describe('summarizeCbm — warm starts', () => {
  it('separates warm starts from index attempts', () => {
    const rows = [
      ...Array.from({ length: 7 }, () => row({ bootstrapResult: 'skipped_warm' })),
      ...Array.from({ length: 2 }, () => row({ bootstrapResult: 'ok' })),
      row({ bootstrapResult: 'failed', bootstrapFailReason: 'timeout after 60000ms' }),
    ];
    const s = summarize(rows);
    expect(s.warmStarts).toBe(7);
    expect(s.warmStartRate).toBeCloseTo(0.7, 5);
    // A warm start built nothing, so it is not an attempt and cannot dilute the
    // failure rate: 1 failure out of 3 real builds, not out of 10 tasks.
    expect(s.indexAttempted).toBe(3);
    expect(s.indexFailed).toBe(1);
    expect(s.indexFailureRate).toBeCloseTo(1 / 3, 5);
  });

  it('surfaces the dominant index failure reason', () => {
    const rows = [
      ...Array.from({ length: 3 }, () =>
        row({ bootstrapResult: 'failed', bootstrapFailReason: 'timeout after 60000ms' })),
      row({ bootstrapResult: 'failed', bootstrapFailReason: 'process exited with code 1' }),
    ];
    expect(summarize(rows).topIndexFailReason).toEqual({
      reason: 'timeout after 60000ms',
      count: 3,
    });
  });
});

describe('summarizeCbm — honesty about payoff', () => {
  it('suppresses deltas and says why when no graph call was ever made', () => {
    const rows = [
      ...Array.from({ length: 6 }, () => row({ bootstrapResult: 'ok', readCount: 20 }, 5000)),
      ...Array.from({ length: 6 }, () =>
        row({ outcome: 'disabled', disableReason: 'role_opt_out', readCount: 40 }, 9000)),
    ];
    const s = summarize(rows);
    // A cohort difference with no mechanism behind it is not efficacy.
    expect(s.inputTokenDeltaPct).toBeNull();
    expect(s.fileAccessDeltaPct).toBeNull();
    expect(s.deltasSuppressedBecause).toBe('no_graph_tool_calls_observed');
  });

  it('reports deltas once a mechanism exists and both cohorts are big enough', () => {
    const rows = [
      ...Array.from({ length: 6 }, () =>
        row({ bootstrapResult: 'ok', toolCalls: { search_graph: 3 }, totalCbmCalls: 3, readCount: 5 }, 4000)),
      ...Array.from({ length: 6 }, () =>
        row({ outcome: 'disabled', disableReason: 'role_opt_out', readCount: 20 }, 8000)),
    ];
    const s = summarize(rows);
    expect(s.deltasSuppressedBecause).toBeNull();
    expect(s.inputTokenDeltaPct).toBeCloseTo(-0.5, 5);
    expect(s.fileAccessDeltaPct).toBeCloseTo(-0.75, 5);
  });

  it('ranks the graph tools actually used', () => {
    const rows = [
      row({ toolCalls: { search_graph: 4, trace_path: 1 }, totalCbmCalls: 5 }),
      row({ toolCalls: { search_graph: 2 }, totalCbmCalls: 2 }),
    ];
    const s = summarize(rows);
    expect(s.topTools[0].tool).toBe('search_graph');
    expect(s.topTools.map(t => t.tool)).not.toContain('get_architecture');
  });
});

describe('aggregateCbm — by-design skips', () => {
  it('keeps decisions out of the fallback rate', () => {
    const rows = [
      ...Array.from({ length: 5 }, () => row({ bootstrapResult: 'ok' })),
      ...Array.from({ length: 5 }, () => row({ outcome: 'disabled', disableReason: 'codex_task' })),
    ];
    const s = summarize(rows);
    // No amount of engineering makes a Codex task use the graph.
    expect(s.eligibleFallbackRate).toBe(0);
    expect(s.byDesignSkips).toEqual({ codex_task: 5 });
  });

  it('counts a missing sandbox mount as breakage, not a decision', () => {
    // Added to the runner separately; if it ever joins BY_DESIGN_SKIP_REASONS a
    // broken mount silently stops counting against the fallback target.
    const rows = [
      ...Array.from({ length: 3 }, () => row({ bootstrapResult: 'ok' })),
      row({ outcome: 'disabled', disableReason: 'mount_unavailable' }),
    ];
    const s = summarize(rows);
    expect(s.mountUnavailable).toBe(1);
    expect(s.byDesignSkips.mount_unavailable).toBeUndefined();
    expect(s.eligibleFallbackRate).toBeCloseTo(0.25, 5);
  });

  it('counts a missing binary as a real fallback', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => row({ bootstrapResult: 'ok' })),
      row({ outcome: 'disabled', disableReason: 'binary_absent' }),
    ];
    expect(summarize(rows).eligibleFallbackRate).toBeCloseTo(0.25, 5);
  });
});
