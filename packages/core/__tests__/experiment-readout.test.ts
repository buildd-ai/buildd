import { describe, it, expect } from 'bun:test';
import {
  assembleReadoutRows,
  classifyRow,
  computeExperimentReadout,
  newcombeInterval,
  wilsonInterval,
  type ReadoutRow,
} from '../experiment-readout';

let seq = 0;
function row(over: Partial<ReadoutRow> = {}): ReadoutRow {
  seq++;
  return {
    taskId: `t-${seq}`, arm: 'control', served: true, unitType: 'task', unitId: `t-${seq}`,
    inherited: false, kind: 'engineering', taskStatus: 'completed', hasPr: false, prMerged: false,
    prAbandoned: false, ciRetryDispatched: false, reworkRounds: 0, reviewerRework: false,
    turns: 10, tokens: null, exitCause: null, ...over,
  };
}
const many = (n: number, over: Partial<ReadoutRow>) => Array.from({ length: n }, () => row(over));

describe('classifyRow (clean completion)', () => {
  const r = (over: Partial<ReadoutRow>) => classifyRow(row(over));
  it('completed with no PR is clean', () => expect(r({})).toBe('clean'));
  it('completed with merged PR is clean', () => expect(r({ hasPr: true, prMerged: true })).toBe('clean'));
  it('a CI retry makes it unclean even when the PR merged', () => {
    expect(r({ hasPr: true, prMerged: true, ciRetryDispatched: true })).toBe('unclean');
  });
  it('completed with an open PR is pending, not unclean', () => expect(r({ hasPr: true })).toBe('pending'));
  it('completed with an abandoned PR is unclean', () => expect(r({ hasPr: true, prAbandoned: true })).toBe('unclean'));
  it('failed is unclean', () => expect(r({ taskStatus: 'failed' })).toBe('unclean'));
  it('in-flight is pending', () => {
    for (const s of ['pending', 'assigned', 'in_progress', 'review']) expect(r({ taskStatus: s })).toBe('pending');
  });
});

describe('intervals', () => {
  it('wilson matches a textbook value (8/10 → ~[0.490, 0.943])', () => {
    const w = wilsonInterval(8, 10);
    expect(w.lower).toBeCloseTo(0.4902, 3);
    expect(w.upper).toBeCloseTo(0.9433, 3);
  });
  it('wilson stays inside [0,1] at the extremes and is [0,1] at n=0', () => {
    expect(wilsonInterval(0, 5).lower).toBe(0);
    expect(wilsonInterval(5, 5).upper).toBe(1);
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
  });
  it('newcombe matches the published worked example (56/70 vs 48/80)', () => {
    // Newcombe (1998), method 10: difference 0.2, 95% CI 0.0524 to 0.3339.
    const d = newcombeInterval(56, 70, 48, 80);
    expect(d.difference).toBeCloseTo(0.2, 6);
    expect(d.lower).toBeCloseTo(0.0524, 3);
    expect(d.upper).toBeCloseTo(0.3339, 3);
  });
});

describe('computeExperimentReadout', () => {
  it('is insufficient_n below the minimum in either arm, whatever the estimates', () => {
    const rows = [...many(5, { arm: 'control', taskStatus: 'failed' }), ...many(40, { arm: 'treatment' })];
    const r = computeExperimentReadout(rows, { minSamplePerArm: 10 });
    expect(r.verdict).toBe('insufficient_n');
    expect(r.control.n).toBe(5);
  });

  it('reports treatment_better when the Newcombe interval excludes zero upward', () => {
    const rows = [
      ...many(40, { arm: 'control' }), ...many(60, { arm: 'control', taskStatus: 'failed' }),
      ...many(80, { arm: 'treatment' }), ...many(20, { arm: 'treatment', taskStatus: 'failed' }),
    ];
    const r = computeExperimentReadout(rows, { minSamplePerArm: 30 });
    expect(r.control.cleanRate).toBeCloseTo(0.4, 6);
    expect(r.treatment.cleanRate).toBeCloseTo(0.8, 6);
    expect(r.difference!.lower).toBeGreaterThan(0);
    expect(r.verdict).toBe('treatment_better');
  });

  it('reports treatment_worse symmetrically', () => {
    const rows = [
      ...many(80, { arm: 'control' }), ...many(20, { arm: 'control', taskStatus: 'failed' }),
      ...many(40, { arm: 'treatment' }), ...many(60, { arm: 'treatment', taskStatus: 'failed' }),
    ];
    expect(computeExperimentReadout(rows, { minSamplePerArm: 30 }).verdict).toBe('treatment_worse');
  });

  it('reports no_detectable_difference when the interval spans zero', () => {
    const rows = [
      ...many(35, { arm: 'control' }), ...many(15, { arm: 'control', taskStatus: 'failed' }),
      ...many(36, { arm: 'treatment' }), ...many(14, { arm: 'treatment', taskStatus: 'failed' }),
    ];
    expect(computeExperimentReadout(rows, { minSamplePerArm: 30 }).verdict).toBe('no_detectable_difference');
  });

  it('is intent-to-treat: an unserved treatment row stays in treatment', () => {
    const rows = [row({ arm: 'treatment', served: false, taskStatus: 'failed' }), row({ arm: 'treatment' })];
    const r = computeExperimentReadout(rows, { minSamplePerArm: 1 });
    expect(r.treatment.n).toBe(2);
    expect(r.treatment.servedRate).toBe(0.5);
    expect(r.control.n).toBe(0);
  });

  it('excludes inherited attempt rows from the unit count and reports them', () => {
    const rows = [row({ arm: 'treatment' }), row({ arm: 'treatment', inherited: true, taskStatus: 'failed' })];
    const r = computeExperimentReadout(rows, { minSamplePerArm: 1 });
    expect(r.treatment.n).toBe(1);
    expect(r.inheritedExcluded).toBe(1);
  });

  it('keeps pending rows out of the denominator', () => {
    const rows = [row({ arm: 'control' }), row({ arm: 'control', taskStatus: 'in_progress' }), row({ arm: 'control', hasPr: true })];
    const r = computeExperimentReadout(rows, { minSamplePerArm: 1 });
    expect(r.control).toMatchObject({ assigned: 3, n: 1, pending: 2, clean: 1 });
  });

  it('computes secondary metrics, excluding infra exit causes from model-attributable failure', () => {
    const rows = [
      row({ arm: 'control', taskStatus: 'failed', exitCause: 'infra_failure' }),
      row({ arm: 'control', taskStatus: 'failed', exitCause: 'code_failure' }),
      row({ arm: 'control', reviewerRework: true, reworkRounds: 2, turns: 30, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } }),
      row({ arm: 'control', turns: 10, tokens: { input: 30, output: 40, cacheRead: 50, cacheWrite: 60 } }),
    ];
    const s = computeExperimentReadout(rows, { minSamplePerArm: 1 }).control.secondary;
    expect(s.modelAttributableFailureRate).toBeCloseTo(0.25, 6);
    expect(s.firstPassReviewRate).toBeCloseTo(0.75, 6);
    expect(s.meanReworkRounds).toBeCloseTo(0.5, 6);
    expect(s.meanTurns).toBeCloseTo(15, 6);
    expect(s.meanTokens).toEqual({ input: 20, output: 30, cacheRead: 40, cacheWrite: 50 });
  });

  it('stratifies by unit type and by kind stated vs unstated', () => {
    const rows = [
      row({ arm: 'control', unitType: 'mission', kind: null }),
      row({ arm: 'treatment', unitType: 'mission', kind: 'research' }),
      row({ arm: 'treatment', unitType: 'task', kind: null, taskStatus: 'failed' }),
    ];
    const r = computeExperimentReadout(rows, { minSamplePerArm: 1 });
    expect(r.strata.unitType.mission.control.n).toBe(1);
    expect(r.strata.unitType.mission.treatment.n).toBe(1);
    expect(r.strata.unitType.task.control.n).toBe(0);
    expect(r.strata.unitType.task.difference).toBeNull();
    expect(r.strata.kind.unstated.control.n).toBe(1);
    expect(r.strata.kind.unstated.treatment.clean).toBe(0);
    expect(r.strata.kind.stated.treatment.clean).toBe(1);
  });
});

describe('assembleReadoutRows', () => {
  const assignment = {
    taskId: 'p', arm: 'treatment' as const, served: true, unitType: 'task' as const, unitId: 'p',
    eligibility: { source: 'drawn' }, kind: 'engineering', taskStatus: 'completed',
  };

  it('joins workers, attempt children and outcomes onto the assignment', () => {
    const [r] = assembleReadoutRows(
      [assignment],
      [
        { taskId: 'p', prUrl: null, mergedAt: null, prLifecycleStatus: null, turns: 3, resultMeta: null, createdAt: '2026-01-01T00:00:00Z' },
        {
          taskId: 'p', prUrl: 'https://example.invalid/pr/1', mergedAt: '2026-01-03T00:00:00Z', prLifecycleStatus: 'merged', turns: 7,
          resultMeta: { modelUsage: { a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 }, b: { inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
      [
        { parentTaskId: 'p', ciRetryPrNumber: 1, reviewerRetryPrNumber: null },
        { parentTaskId: 'p', ciRetryPrNumber: null, reviewerRetryPrNumber: 1 },
        { parentTaskId: 'other', ciRetryPrNumber: 1, reviewerRetryPrNumber: null },
      ],
      [
        { taskId: 'p', exitCause: 'code_failure', createdAt: '2026-01-01T00:00:00Z' },
        { taskId: 'p', exitCause: null, createdAt: '2026-01-04T00:00:00Z' },
      ],
    );
    expect(r).toMatchObject({
      hasPr: true, prMerged: true, prAbandoned: false, ciRetryDispatched: true, reworkRounds: 1,
      reviewerRework: true, turns: 10, tokens: { input: 11, output: 2, cacheRead: 3, cacheWrite: 4 },
      exitCause: null, inherited: false,
    });
    expect(classifyRow(r)).toBe('unclean');
  });

  it('marks a closed-unmerged PR abandoned and an inherited row inherited', () => {
    const [r] = assembleReadoutRows(
      [{ ...assignment, eligibility: { source: 'inherited', inheritedFromTaskId: 'x' } }],
      [{ taskId: 'p', prUrl: 'u', mergedAt: null, prLifecycleStatus: 'closed', turns: null, resultMeta: null, createdAt: new Date() }],
      [], [],
    );
    expect(r).toMatchObject({ prAbandoned: true, prMerged: false, inherited: true, turns: null, tokens: null });
  });
});
