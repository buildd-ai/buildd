import { describe, expect, it } from 'bun:test';
import { CLAIM_PLANNER_CALIBRATION, overlapPairKey, planClaimBatch } from '@buildd/core/claim-planner';
import {
  buildClaimPlanInput,
  EMPTY_PLANNER_SIGNALS,
  plannerScopedTaskIds,
  resolveClaimPlannerConfig,
  splitOwnOpenPrs,
  type ClaimPlanSource,
  type OpenPrEntry,
  type PlannerSignals,
} from './claim-plan-input';

const THRESHOLDS = { thetaOrder: 0.3, thetaSoft: 0.5, thetaIdle: 0.8 };

function task(id: string, over: Record<string, unknown> = {}) {
  return { id, workspaceId: 'ws-1', missionId: 'm1', priority: 0, createdAt: '2026-01-01T00:00:00Z', pathManifest: null, ...over };
}

function pr(taskId: string, prNumber: number, pathManifest: string[] | null, over: Partial<OpenPrEntry> = {}): OpenPrEntry {
  return { taskId, prNumber, prUrl: `https://example.test/pull/${prNumber}`, pathManifest, branch: `b-${prNumber}`, prBaseRef: 'dev', ...over };
}

function source(over: Partial<ClaimPlanSource>): ClaimPlanSource {
  return {
    candidates: [],
    openPrTasksByWorkspace: new Map(),
    activePathClaimsByWorkspace: new Map(),
    missionInFlightRows: [],
    claimedThisBatch: [],
    capacity: 3,
    pressure: null,
    thresholds: null,
    signals: EMPTY_PLANNER_SIGNALS,
    ...over,
  };
}

function signals(over: Partial<PlannerSignals>): PlannerSignals {
  return { ...EMPTY_PLANNER_SIGNALS, ...over };
}

const picks = (src: ClaimPlanSource) => planClaimBatch(buildClaimPlanInput(src).input).picks.map(p => p.id);

describe('resolveClaimPlannerConfig', () => {
  it('defaults to apply when the workspace sets no mode', () => {
    expect(resolveClaimPlannerConfig(null)).toEqual({ mode: 'apply', thresholds: null });
    expect(resolveClaimPlannerConfig({})).toEqual({ mode: 'apply', thresholds: null });
    expect(resolveClaimPlannerConfig({ claimPlanner: null })).toEqual({ mode: 'apply', thresholds: null });
  });

  it('an explicit off, or an unrecognised mode, is off', () => {
    expect(resolveClaimPlannerConfig({ claimPlanner: 'off' })).toEqual({ mode: 'off', thresholds: null });
    expect(resolveClaimPlannerConfig({ claimPlanner: 'yes' })).toEqual({ mode: 'off', thresholds: null });
  });

  it('reads record / apply and well-formed thresholds', () => {
    expect(resolveClaimPlannerConfig({ claimPlanner: 'record' }).mode).toBe('record');
    expect(resolveClaimPlannerConfig({ claimPlanner: 'apply', claimPlannerThresholds: THRESHOLDS })).toEqual({ mode: 'apply', thresholds: THRESHOLDS });
  });

  it('drops malformed thresholds rather than half-applying them', () => {
    expect(resolveClaimPlannerConfig({ claimPlanner: 'apply', claimPlannerThresholds: { thetaOrder: 0.3, thetaSoft: 2, thetaIdle: 0.8 } }).thresholds).toBeNull();
    expect(resolveClaimPlannerConfig({ claimPlanner: 'apply', claimPlannerThresholds: { thetaOrder: 0.3 } }).thresholds).toBeNull();
  });

  it('falls back to the pinned calibration when the workspace sets no thresholds', () => {
    expect(resolveClaimPlannerConfig({ claimPlanner: 'record' }).thresholds).toEqual(CLAIM_PLANNER_CALIBRATION.thresholds);
    expect(resolveClaimPlannerConfig({ claimPlanner: 'apply', claimPlannerThresholds: { thetaOrder: 2 } }).thresholds)
      .toEqual(CLAIM_PLANNER_CALIBRATION.thresholds);
  });

  it('a workspace override wins over the pinned calibration', () => {
    expect(resolveClaimPlannerConfig({ claimPlanner: 'apply', claimPlannerThresholds: THRESHOLDS }).thresholds).toEqual(THRESHOLDS);
  });
});

describe('splitOwnOpenPrs', () => {
  it('a fix attempt owns the PR it fixes and anything stacked on it', () => {
    const base = pr('orig', 10, ['a.ts']);
    const stacked = pr('later', 11, ['a.ts'], { prBaseRef: 'b-10' });
    const other = pr('x', 12, ['a.ts']);
    const { own, others } = splitOwnOpenPrs({ id: 'fix', reviewerRetryPrNumber: 10 }, [base, stacked, other]);
    expect(own).toEqual([base, stacked]);
    expect(others).toEqual([other]);
  });

  it('a task owns a PR its own earlier worker opened', () => {
    const mine = pr('t', 5, ['a.ts']);
    expect(splitOwnOpenPrs({ id: 't' }, [mine]).own).toEqual([mine]);
  });
});

describe('buildClaimPlanInput', () => {
  it('orders a candidate behind an open PR with overlapping files', () => {
    const src = source({
      candidates: [task('a', { pathManifest: ['src/x.ts'] })],
      openPrTasksByWorkspace: new Map([['ws-1', [pr('p', 1, ['src/x.ts'])]]]),
    });
    const plan = planClaimBatch(buildClaimPlanInput(src).input);
    expect(plan.picks).toEqual([]);
    expect(plan.orientation[0]).toMatchObject({ taskId: 'a', reason: 'open_pr', edge: 'open_pr_overlap' });
  });

  it('a fix attempt is not ordered behind the PR it was dispatched to fix', () => {
    expect(picks(source({
      candidates: [task('fix', { pathManifest: ['src/x.ts'], ciRetryPrNumber: 1 })],
      openPrTasksByWorkspace: new Map([['ws-1', [pr('orig', 1, ['src/x.ts'])]]]),
    }))).toEqual(['fix']);
  });

  it('a live lease held by another task orders the candidate behind it; its own lease does not', () => {
    const leases = new Map([['ws-1', new Map([['other', ['src/x.ts']], ['a', ['src/y.ts']]])]]);
    const plan = planClaimBatch(buildClaimPlanInput(source({
      candidates: [task('a', { pathManifest: ['src/x.ts', 'src/y.ts'] })],
      activePathClaimsByWorkspace: leases,
    })).input);
    expect(plan.picks).toEqual([]);
    expect(plan.orientation[0]).toMatchObject({ blockedBy: 'lease:other', edge: 'lease_overlap' });
  });

  it('the same path in two workspaces is not an overlap', () => {
    expect(picks(source({
      candidates: [task('a', { pathManifest: ['src/x.ts'] }), task('b', { workspaceId: 'ws-2', pathManifest: ['src/x.ts'] })],
    })).sort()).toEqual(['a', 'b']);
  });

  it('keeps the one-per-mission mutex for scope-undeclared work, in flight or in the batch', () => {
    const inFlight = source({
      candidates: [task('a', { pathManifest: ['**'] })],
      missionInFlightRows: [{ missionId: 'm1', taskId: 'w', pathManifest: ['**'], category: null, outputRequirement: null }],
    });
    expect(picks(inFlight)).toEqual([]);
    const batch = source({ candidates: [task('a'), task('b')] });
    expect(picks(batch)).toHaveLength(1);
  });

  it('review and no-edit work neither take nor wait for the mutex', () => {
    expect(picks(source({
      candidates: [task('r', { category: 'review' }), task('n', { outputRequirement: 'none' })],
      missionInFlightRows: [{ missionId: 'm1', taskId: 'w', pathManifest: null, category: null, outputRequirement: null }],
    })).sort()).toEqual(['n', 'r']);
    expect(picks(source({
      candidates: [task('a')],
      missionInFlightRows: [{ missionId: 'm1', taskId: 'w', pathManifest: null, category: 'review', outputRequirement: null }],
    }))).toEqual(['a']);
  });

  it('a confident prediction replaces the mutex with real edges; a weak one leaves it', () => {
    const preds = (conf: number) => signals({
      predictions: new Map([
        ['a', { selected: ['src/a.ts'], setConfidence: conf, expectedSize: null, unknownScope: false }],
        ['b', { selected: ['src/b.ts'], setConfidence: conf, expectedSize: null, unknownScope: false }],
      ]),
    });
    const confident = source({ candidates: [task('a'), task('b')], thresholds: THRESHOLDS, signals: preds(0.9) });
    expect(picks(confident).sort()).toEqual(['a', 'b']);
    expect([...plannerScopedTaskIds(buildClaimPlanInput(confident))].sort()).toEqual(['a', 'b']);
    const weak = source({ candidates: [task('a'), task('b')], thresholds: THRESHOLDS, signals: preds(0.1) });
    expect(picks(weak)).toHaveLength(1);
    expect(plannerScopedTaskIds(buildClaimPlanInput(weak)).size).toBe(0);
  });

  it('null thresholds ignore predictions entirely', () => {
    const src = source({
      candidates: [task('a'), task('b')],
      thresholds: null,
      signals: signals({ predictions: new Map([['a', { selected: ['src/a.ts'], setConfidence: 0.99, expectedSize: null, unknownScope: false }]]) }),
    });
    expect(picks(src)).toHaveLength(1);
    expect(plannerScopedTaskIds(buildClaimPlanInput(src)).size).toBe(0);
  });

  it('an unknown-scope prediction is never scope', () => {
    const src = source({
      candidates: [task('a')],
      thresholds: THRESHOLDS,
      signals: signals({ predictions: new Map([['a', { selected: ['src/a.ts'], setConfidence: 0.99, expectedSize: null, unknownScope: true }]]) }),
    });
    expect(buildClaimPlanInput(src).input.candidates[0].predictedScope).toBeNull();
  });

  it('a task claimed earlier in the batch is in flight for the next plan', () => {
    const plan = planClaimBatch(buildClaimPlanInput(source({
      candidates: [task('b', { pathManifest: ['src/x.ts'] })],
      claimedThisBatch: [task('a', { pathManifest: ['src/x.ts'] })],
    })).input);
    expect(plan.picks).toEqual([]);
    expect(plan.orientation[0]).toMatchObject({ taskId: 'b', blockedBy: 'w:a', reason: 'in_flight' });
  });

  it('carries starvation credit, dependents and size from the signals', () => {
    const { input } = buildClaimPlanInput(source({
      candidates: [task('a')],
      signals: signals({
        starvationCredit: new Map([['a', 7]]),
        dependentCount: new Map([['a', 2]]),
        predictions: new Map([['a', { selected: [], setConfidence: null, expectedSize: { files: 3, minutes: 20 }, unknownScope: true }]]),
      }),
    }));
    expect(input.candidates[0]).toMatchObject({ starvationCredit: 7, dependentCount: 2, expectedSize: { files: 3, minutes: 20 } });
  });

  it('maps a stored task-pair answer onto every node those tasks own', () => {
    const { input } = buildClaimPlanInput(source({
      candidates: [task('a', { pathManifest: ['src/x.ts'] })],
      activePathClaimsByWorkspace: new Map([['ws-1', new Map([['b', ['src/y.ts']]])]]),
      signals: signals({ overlapAnswers: [{ taskAId: 'b', taskBId: 'a', answer: 'NOT_REAL' }] }),
    }));
    expect(input.overlapAnswers?.[overlapPairKey('a', 'lease:b')]).toBe('NOT_REAL');
  });
});
