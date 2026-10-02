/**
 * CBM health summary.
 *
 * The failure this page missed for weeks was "mounted, indexed, never queried" —
 * which reads as perfect health under any availability-only summary. These tests
 * pin the states that matter, using the shapes seen in production.
 */
import { describe, it, expect } from 'bun:test';
import { aggregateCbm, aggregateCbmInjection, summarizeCbm, type CbmRow } from './cbm-insight';
import { emptyCbmInjectionMetrics, type CbmInjectionMetrics } from '@buildd/core/cbm-injection';
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

  // A build that overran the startup wait budget is handed off, not aborted.
  // These pin the accounting, because reclassifying overruns out of `failed`
  // improves the failure rate by definition — the claim only means something if
  // the backgrounded bucket and its landing rate are visible next to it.
  it('counts a backgrounded build as an attempt but not as a failure', () => {
    const rows = [
      ...Array.from({ length: 5 }, () => row({ bootstrapResult: 'ok' })),
      ...Array.from({ length: 4 }, () =>
        row({ bootstrapResult: 'backgrounded', backgroundIndexLanded: true })),
      row({ bootstrapResult: 'failed', bootstrapFailReason: 'process exited with code 1' }),
    ];
    const s = summarize(rows);
    expect(s.indexAttempted).toBe(10);
    expect(s.indexFailed).toBe(1);
    expect(s.indexFailureRate).toBeCloseTo(0.1, 5);
    expect(s.indexBackgrounded).toBe(4);
    expect(s.indexBackgroundedRate).toBeCloseTo(0.4, 5);
  });

  it('reports how often a backgrounded build actually landed', () => {
    const rows = [
      ...Array.from({ length: 3 }, () =>
        row({ bootstrapResult: 'backgrounded', backgroundIndexLanded: true })),
      row({ bootstrapResult: 'backgrounded', backgroundIndexLanded: false }),
    ];
    const s = summarize(rows);
    expect(s.indexBackgrounded).toBe(4);
    expect(s.backgroundIndexLandedRate).toBeCloseTo(0.75, 5);
  });

  it('reports a null landing rate rather than 0% when nothing was backgrounded', () => {
    const s = summarize(Array.from({ length: 3 }, () => row({ bootstrapResult: 'ok' })));
    expect(s.indexBackgrounded).toBe(0);
    // null, not 0 — "never happened" must not render as "never landed".
    expect(s.backgroundIndexLandedRate).toBeNull();
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
    // `codex_task` now means only "CBM-for-Codex is switched off fleet-wide" —
    // still a configuration decision, so still out of the fallback rate.
    expect(s.eligibleFallbackRate).toBe(0);
    expect(s.byDesignSkips).toEqual({ codex_task: 5 });
  });

  it('counts a CBM-enforced Codex worker in the eligible cohort and the adoption denominator', () => {
    // Regression for the shape the metric could not see: CBM is mounted for Codex
    // tasks (stdio server in the worker's Codex config.toml), so such a worker is
    // `enforced`, not a `codex_task` skip. If it were still recorded as a
    // by-design skip it would leave BOTH sides of the adoption rate while the
    // graph was actually mounted — a mounted-and-unused Codex fleet would read as
    // a healthy Claude-only one.
    const codexEnforcedUnused = row({ bootstrapResult: 'ok', readCount: 4 });
    const codexEnforcedUsed = row({
      bootstrapResult: 'ok',
      toolCalls: { search_graph: 3 },
      totalCbmCalls: 3,
    });
    const agg = aggregateCbm([codexEnforcedUnused, codexEnforcedUsed], '7d', WINDOW_START);
    expect(agg.cbmActive.count).toBe(2);
    expect(agg.eligibility.eligibleCount).toBe(2);
    expect(agg.eligibility.byDesignSkipCount).toBe(0);
    // Denominator is every mounted task, not only the ones that queried.
    expect(agg.cbmActive.adoptionRate).toBeCloseTo(0.5, 5);
  });

  it('reports a Codex worker with no worktree as no_worktree, not codex_task', () => {
    // The runner used to test isCodexTask first, so every skip on a Codex task
    // read `codex_task`. Both reasons are by-design, so the aggregate totals look
    // the same — the loss was diagnostic, and `binary_absent` (breakage) was
    // masked the same way, which is NOT by-design. The label has to survive.
    const rows = [
      ...Array.from({ length: 3 }, () => row({ bootstrapResult: 'ok' })),
      row({ outcome: 'disabled', disableReason: 'no_worktree' }),
      row({ outcome: 'disabled', disableReason: 'binary_absent' }),
    ];
    const s = summarize(rows);
    expect(s.byDesignSkips).toEqual({ no_worktree: 1 });
    expect(s.binaryAbsent).toBe(1);
    // The masked breakage now counts against the fallback target: 1 of 4 eligible.
    expect(s.eligibleFallbackRate).toBeCloseTo(0.25, 5);
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

describe('aggregateCbmInjection (cbm-search-injection.md, kill metric)', () => {
  const block = (over: Partial<CbmInjectionMetrics>): CbmInjectionMetrics => ({ ...emptyCbmInjectionMetrics(true), ...over });

  it('null rates and insufficient_n with nothing to read', () => {
    const agg = aggregateCbmInjection([undefined]);
    expect(agg).toMatchObject({ sessions: 0, injectedRate: null, uptakeRate: null, killMetric: { verdict: 'insufficient_n' } });
  });

  it('injectedRate drops cap/repeat/unsupported from the denominator; uptakeRate is taken over tracked', () => {
    const agg = aggregateCbmInjection([
      block({
        triggers: 6, nonEmptyDiff: 2, injections: 2,
        byOutcome: { empty_diff: 2, injected_callers: 1, jev_skip: 1, cap_reached: 1, repeat_symbol: 1 },
        uptake: { window: 10, tracked: 2, taken: 1 },
        events: [
          { trigger: 'bash', outcome: 'injected_callers', hitCount: 1, hitFiles: 1, graphCount: 3, diffSize: 2, injectedCount: 2, symbolKind: 'Function', latencyMs: 300, jev: { label: 'inject_callers', confidence: 0.9, status: 'applied', latencyMs: 120, version: 'v' } },
          { trigger: 'grep', outcome: 'jev_skip', hitCount: 9, hitFiles: 5, graphCount: 3, diffSize: 1, injectedCount: 0, symbolKind: 'Method', latencyMs: 500, jev: { label: 'skip', confidence: 0.4, status: 'below_threshold', latencyMs: 200, version: 'v' } },
          { trigger: 'bash', outcome: 'cap_reached', hitCount: 0, hitFiles: 0, graphCount: 0, diffSize: 0, injectedCount: 0, symbolKind: null, latencyMs: 0 },
        ],
      }),
      emptyCbmInjectionMetrics(false, 'kill_switch'),
      { ...emptyCbmInjectionMetrics(false, 'unsupported_backend'), triggers: 3, byOutcome: { unsupported_backend: 3 } },
    ]);
    expect(agg.sessions).toBe(3);
    expect(agg.enabledSessions).toBe(1);
    expect(agg.disabledReasons).toEqual({ kill_switch: 1, unsupported_backend: 1 });
    expect(agg.triggers).toBe(9);
    expect(agg.eligibleTriggers).toBe(4);
    expect(agg.injectedRate).toBe(0.5);
    expect(agg.uptakeRate).toBe(0.5);
    expect(agg.jev).toMatchObject({ calls: 2, labels: { inject_callers: 1, skip: 1 }, fallbackShare: 0.5 });
    // Ineligible rows never count toward latency.
    expect(agg.hookLatencyMs).toEqual({ p50: 500, p90: 500 });
    expect(agg.killMetric.sessionsWithEligibleTrigger).toBe(1);
  });

  it('verdict kills below either threshold once n is reached, keeps otherwise', () => {
    const good = block({ triggers: 10, nonEmptyDiff: 5, injections: 3, byOutcome: { empty_diff: 5, injected_callers: 3, jev_skip: 2 }, uptake: { window: 10, tracked: 3, taken: 2 } });
    const thin = block({ triggers: 10, nonEmptyDiff: 0, byOutcome: { empty_diff: 10 } });
    const kill = { sessions: 2, minInjectedRate: 0.1, minUptakeRate: 0.15 };
    expect(aggregateCbmInjection([good, good], kill).killMetric.verdict).toBe('keep');
    expect(aggregateCbmInjection([thin, thin], kill).killMetric.verdict).toBe('kill');
    expect(aggregateCbmInjection([good], kill).killMetric.verdict).toBe('insufficient_n');
  });

  it('rides on aggregateCbm and leaves the adoption numbers alone', () => {
    const cbm = { outcome: 'enforced' as const, sharedCache: true, toolCalls: {}, totalCbmCalls: 0, readCount: 0, grepCount: 1, globCount: 0, injection: block({ triggers: 1, injections: 1, nonEmptyDiff: 1, byOutcome: { injected_callers: 1 } }) };
    const agg = aggregateCbm([{ inputTokens: 1, cbm }], '7d', new Date(0));
    expect(agg.injection.injections).toBe(1);
    expect(agg.cbmActive.adoptionRate).toBe(0);
    expect(agg.cbmActive.totalGraphCalls).toBe(0);
  });
});
