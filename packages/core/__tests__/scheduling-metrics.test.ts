import { describe, it, expect } from 'bun:test';
import {
  isoWeekStart,
  isoWeekLabel,
  weekKey,
  rate,
  buildWeekMetrics,
  buildSchedulingMetricsReadout,
  type WeeklySchedulingRawInput,
} from '../scheduling-metrics';

const WS = 'ws-1';

function week(partial: Partial<WeeklySchedulingRawInput> & { weekStart: Date; mode: WeeklySchedulingRawInput['mode'] }): WeeklySchedulingRawInput {
  return {
    workspaceId: WS,
    weekStart: partial.weekStart,
    mode: partial.mode,
    deferrals: { path_overlap: 0, advisory_manifest: 0, ordered_behind: 0, codex_single_flight: 0 },
    claimedTaskCount: 0,
    strandedCount: 0,
    mergeLatenciesMs: [],
    conflictTaskCount: 0,
    mergedPrCount: 0,
    unsafeCoScheduleCount: 0,
    coScheduleSampleCount: 0,
    silentCompletionCount: 0,
    supersessionCancelCount: 0,
    supersessionRevertedCount: 0,
    claimPlans: [],
    plannerWouldBePickLabels: [],
    ...partial,
  };
}

describe('isoWeekStart / isoWeekLabel / weekKey', () => {
  it('floors to the Monday 00:00 UTC of the ISO week', () => {
    // 2026-10-04 is a Sunday; its ISO week starts Monday 2026-09-28.
    const d = new Date('2026-10-04T15:30:00Z');
    const start = isoWeekStart(d);
    expect(start.toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });

  it('a Monday maps to itself', () => {
    const d = new Date('2026-09-28T09:00:00Z');
    expect(isoWeekStart(d).toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });

  it('labels the ISO week number, handling a year boundary', () => {
    // 2025-12-29 (Mon) starts ISO week 2026-W01 (the week with the year's first Thursday).
    expect(isoWeekLabel(isoWeekStart(new Date('2025-12-31T00:00:00Z')))).toBe('2026-W01');
    expect(isoWeekLabel(isoWeekStart(new Date('2026-10-04T00:00:00Z')))).toBe('2026-W40');
  });

  it('weekKey is a stable date string for the bucket', () => {
    expect(weekKey(new Date('2026-10-04T15:30:00Z'))).toBe('2026-09-28');
  });
});

describe('rate', () => {
  it('divides when the denominator is positive', () => {
    expect(rate(3, 10)).toBe(0.3);
  });
  it('is null, not NaN or Infinity, for a zero denominator', () => {
    expect(rate(3, 0)).toBeNull();
    expect(rate(0, 0)).toBeNull();
  });
});

describe('buildWeekMetrics — single-week derived metrics', () => {
  it('computes deferrals-per-claimed-task from the three primary reasons only', () => {
    const w = week({
      weekStart: new Date('2026-09-28T00:00:00Z'),
      mode: 'apply',
      deferrals: { path_overlap: 4, advisory_manifest: 2, ordered_behind: 6, codex_single_flight: 9 },
      claimedTaskCount: 6,
    });
    const m = buildWeekMetrics(w);
    // (4 + 2 + 6) / 6 = 2 — codex_single_flight is reported distinctly, not folded in.
    expect(m.primary.deferralsPerClaimedTask.value).toBe(2);
    expect(m.providerCapacity.codexSingleFlightDeferrals).toBe(9);
  });

  it('is null (not zero) when no tasks were claimed that week', () => {
    const w = week({ weekStart: new Date('2026-09-28T00:00:00Z'), mode: 'off', claimedTaskCount: 0, deferrals: { path_overlap: 1, advisory_manifest: 0, ordered_behind: 0, codex_single_flight: 0 } });
    expect(buildWeekMetrics(w).primary.deferralsPerClaimedTask.value).toBeNull();
  });

  it('reports stranded count as-is (already deduped upstream)', () => {
    const w = week({ weekStart: new Date('2026-09-28T00:00:00Z'), mode: 'off', strandedCount: 3 });
    expect(buildWeekMetrics(w).primary.strandedCount).toBe(3);
  });

  it('computes p50/p90 time-to-merge from the week\'s merge latencies', () => {
    const w = week({
      weekStart: new Date('2026-09-28T00:00:00Z'),
      mode: 'off',
      mergeLatenciesMs: [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000],
    });
    const m = buildWeekMetrics(w);
    expect(m.primary.timeToMergeMs.p50).toBe(5000);
    expect(m.primary.timeToMergeMs.p90).toBe(9000);
  });

  it('time-to-merge is null with no merged editing tasks that week', () => {
    const w = week({ weekStart: new Date('2026-09-28T00:00:00Z'), mode: 'off' });
    const m = buildWeekMetrics(w);
    expect(m.primary.timeToMergeMs.p50).toBeNull();
    expect(m.primary.timeToMergeMs.p90).toBeNull();
  });

  it('computes conflict tasks per merged PR', () => {
    const w = week({ weekStart: new Date('2026-09-28T00:00:00Z'), mode: 'off', conflictTaskCount: 5, mergedPrCount: 20 });
    expect(buildWeekMetrics(w).primary.conflictTasksPerMergedPr.value).toBe(0.25);
  });

  it('conflict-per-merged-pr is null with no merged PRs', () => {
    const w = week({ weekStart: new Date('2026-09-28T00:00:00Z'), mode: 'off', conflictTaskCount: 5, mergedPrCount: 0 });
    expect(buildWeekMetrics(w).primary.conflictTasksPerMergedPr.value).toBeNull();
  });

  describe('guardrails', () => {
    it('computes the unsafe co-schedule rate from sampled co-running pairs', () => {
      const w = week({ weekStart: new Date('2026-09-28T00:00:00Z'), mode: 'off', unsafeCoScheduleCount: 2, coScheduleSampleCount: 8 });
      expect(buildWeekMetrics(w).guardrails.unsafeCoScheduleRate.value).toBe(0.25);
    });

    it('idle capacity counts only samples where capacity was known, unused AND claimable work remained', () => {
      const w = week({
        weekStart: new Date('2026-09-28T00:00:00Z'),
        mode: 'apply',
        claimPlans: [
          // capacity 3, picked 1, 5 candidates offered: idle capacity while claimable work existed.
          { mode: 'apply', backend: 'claude', agree: true, candidateCount: 5, pickedCount: 1, capacity: 3 },
          // fully used capacity: not idle.
          { mode: 'apply', backend: 'claude', agree: true, candidateCount: 5, pickedCount: 3, capacity: 3 },
          // picked everything offered: no claimable work left, not idle even though capacity unused.
          { mode: 'apply', backend: 'codex', agree: true, candidateCount: 1, pickedCount: 1, capacity: 3 },
          // capacity unknown: excluded from the denominator entirely.
          { mode: 'apply', backend: 'claude', agree: true, candidateCount: 5, pickedCount: 1, capacity: null },
        ],
      });
      const g = buildWeekMetrics(w).guardrails.idleCapacityWhileClaimableRate;
      expect(g.sampleCount).toBe(3);
      expect(g.value).toBeCloseTo(1 / 3);
    });

    it('reports provider-split idle capacity using the same claim-plan samples, never raw runner slots', () => {
      const w = week({
        weekStart: new Date('2026-09-28T00:00:00Z'),
        mode: 'apply',
        claimPlans: [
          { mode: 'apply', backend: 'codex', agree: true, candidateCount: 2, pickedCount: 1, capacity: 1 }, // codex capacity 1 fully used: not idle
          { mode: 'apply', backend: 'codex', agree: true, candidateCount: 3, pickedCount: 0, capacity: 1 }, // codex idle while claimable work existed
          { mode: 'apply', backend: 'claude', agree: true, candidateCount: 4, pickedCount: 2, capacity: 5 }, // claude idle while claimable work existed
        ],
      });
      const byBackend = buildWeekMetrics(w).providerCapacity.idleCapacityByBackend;
      expect(byBackend.codex.sampleCount).toBe(2);
      expect(byBackend.codex.value).toBeCloseTo(0.5);
      expect(byBackend.claude.sampleCount).toBe(1);
      expect(byBackend.claude.value).toBe(1);
    });

    it('a mixed-backend plan sample is excluded from both per-backend splits', () => {
      const w = week({
        weekStart: new Date('2026-09-28T00:00:00Z'),
        mode: 'apply',
        claimPlans: [{ mode: 'apply', backend: 'mixed', agree: true, candidateCount: 4, pickedCount: 1, capacity: 3 }],
      });
      const byBackend = buildWeekMetrics(w).providerCapacity.idleCapacityByBackend;
      expect(byBackend.codex.sampleCount).toBe(0);
      expect(byBackend.claude.sampleCount).toBe(0);
      // Still counted in the overall idle-capacity guardrail.
      expect(buildWeekMetrics(w).guardrails.idleCapacityWhileClaimableRate.sampleCount).toBe(1);
    });

    it('counts silent completions and supersession cancels/reverts as plain counts', () => {
      const w = week({ weekStart: new Date('2026-09-28T00:00:00Z'), mode: 'off', silentCompletionCount: 4, supersessionCancelCount: 10, supersessionRevertedCount: 3 });
      const g = buildWeekMetrics(w).guardrails;
      expect(g.silentCompletionCount).toBe(4);
      expect(g.supersessionCancelCount).toBe(10);
      expect(g.supersessionRevertedCount).toBe(3);
      expect(g.supersessionRevertedRate.value).toBe(0.3);
    });

    it('supersession reverted rate is null with no cancellations', () => {
      const w = week({ weekStart: new Date('2026-09-28T00:00:00Z'), mode: 'off', supersessionCancelCount: 0, supersessionRevertedCount: 0 });
      expect(buildWeekMetrics(w).guardrails.supersessionRevertedRate.value).toBeNull();
    });
  });

  describe('record-mode plan-vs-actual divergence', () => {
    it('is null outside record mode', () => {
      const w = week({ weekStart: new Date('2026-09-28T00:00:00Z'), mode: 'apply', claimPlans: [{ mode: 'apply', backend: 'claude', agree: false, candidateCount: 2, pickedCount: 1, capacity: 2 }] });
      expect(buildWeekMetrics(w).recordOnly).toBeNull();
    });

    it('divergence rate = share of record-mode plans that disagree with the rule\'s actual pick', () => {
      const w = week({
        weekStart: new Date('2026-09-28T00:00:00Z'),
        mode: 'record',
        claimPlans: [
          { mode: 'record', backend: 'claude', agree: true, candidateCount: 2, pickedCount: 1, capacity: 2 },
          { mode: 'record', backend: 'claude', agree: false, candidateCount: 2, pickedCount: 1, capacity: 2 },
          { mode: 'record', backend: 'claude', agree: false, candidateCount: 2, pickedCount: 1, capacity: 2 },
        ],
      });
      const r = buildWeekMetrics(w).recordOnly;
      expect(r).not.toBeNull();
      expect(r!.planDivergenceRate.sampleCount).toBe(3);
      expect(r!.planDivergenceRate.value).toBeCloseTo(2 / 3);
    });

    it('reports the planner\'s would-be-pick guardrail as insufficient_n when no labels exist', () => {
      const w = week({ weekStart: new Date('2026-09-28T00:00:00Z'), mode: 'record', claimPlans: [{ mode: 'record', backend: 'claude', agree: false, candidateCount: 2, pickedCount: 1, capacity: 2 }] });
      expect(buildWeekMetrics(w).recordOnly!.plannerWouldBePickGuardrail).toEqual({ status: 'insufficient_n' });
    });

    it('reports the planner\'s would-be-pick guardrail as observed once labels exist', () => {
      const w = week({
        weekStart: new Date('2026-09-28T00:00:00Z'),
        mode: 'record',
        claimPlans: [{ mode: 'record', backend: 'claude', agree: false, candidateCount: 2, pickedCount: 1, capacity: 2 }],
        plannerWouldBePickLabels: [{ unsafe: true }, { unsafe: false }, { unsafe: false }, { unsafe: false }],
      });
      const g = buildWeekMetrics(w).recordOnly!.plannerWouldBePickGuardrail;
      expect(g).toEqual({ status: 'observed', unsafeCoScheduleRate: 0.25, sampleCount: 4 });
    });
  });
});

describe('buildSchedulingMetricsReadout — baseline comparison', () => {
  const offWeek = week({
    weekStart: new Date('2026-09-07T00:00:00Z'),
    mode: 'off',
    deferrals: { path_overlap: 10, advisory_manifest: 10, ordered_behind: 0, codex_single_flight: 0 },
    claimedTaskCount: 10, // deferralsPerClaimedTask = 2
    strandedCount: 4,
    mergeLatenciesMs: [1000, 1000, 1000, 1000, 10000, 10000, 10000, 10000, 10000, 10000],
    conflictTaskCount: 10,
    mergedPrCount: 10, // 1.0
    unsafeCoScheduleCount: 4,
    coScheduleSampleCount: 10, // 0.4
  });
  const applyWeek = week({
    weekStart: new Date('2026-09-14T00:00:00Z'),
    mode: 'apply',
    deferrals: { path_overlap: 1, advisory_manifest: 1, ordered_behind: 0, codex_single_flight: 0 },
    claimedTaskCount: 10, // deferralsPerClaimedTask = 0.2
    strandedCount: 1,
    mergeLatenciesMs: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
    conflictTaskCount: 1,
    mergedPrCount: 10, // 0.1
    unsafeCoScheduleCount: 1,
    coScheduleSampleCount: 10, // 0.1
  });

  it('groups by workspace and week, and compares each non-off week against the pooled off-mode baseline', () => {
    const readout = buildSchedulingMetricsReadout([offWeek, applyWeek]);
    expect(readout.workspaces).toHaveLength(1);
    const [w] = readout.workspaces;
    expect(w.workspaceId).toBe(WS);
    expect(w.weeks).toHaveLength(2);

    const applyRow = w.weeks.find(r => r.mode === 'apply')!;
    expect(applyRow.vsBaseline).not.toBeNull();
    expect(applyRow.vsBaseline!.deferralsPerClaimedTask!.baseline).toBe(2);
    expect(applyRow.vsBaseline!.deferralsPerClaimedTask!.treatment).toBe(0.2);
    expect(applyRow.vsBaseline!.deferralsPerClaimedTask!.delta).toBeCloseTo(0.2 - 2);

    const offRow = w.weeks.find(r => r.mode === 'off')!;
    expect(offRow.vsBaseline).toBeNull();
  });

  it('vsBaseline is null when the workspace has no off-mode week in the window', () => {
    const readout = buildSchedulingMetricsReadout([applyWeek]);
    expect(readout.workspaces[0].weeks[0].vsBaseline).toBeNull();
  });

  it('never carries anything beyond counts, rates and week identity — no ids, paths or titles', () => {
    const readout = buildSchedulingMetricsReadout([offWeek, applyWeek]);
    const json = JSON.stringify(readout);
    expect(json).not.toContain('/');
    expect(json.toLowerCase()).not.toContain('path');
    expect(json.toLowerCase()).not.toContain('title');
  });
});
