import { describe, expect, it } from 'bun:test';
import type { BlendComparison } from '../estimate-backtest-blend';
import type { BacktestScore } from '../estimate-backtest';
import { ESTIMATOR_VERSION } from '../task-estimate';
import {
  TASK_ESTIMATES_ROLLOUT, defaultOffReason, evaluateTaskEstimatesGate, resolveTaskEstimatesState, taskEstimatesDefaultOn,
  type TaskEstimatesRolloutPin,
} from '../task-estimate-rollout';

const score = (scored: number, medianRatio: number | null, withinP80: number | null): BacktestScore =>
  ({ n: scored, scored, medianRatio, withinP80, medianAbsLogError: 0.4 });

const comparison = (o: { verdict?: BlendComparison['verdict']; neighbours?: BacktestScore; bucket?: BacktestScore; overall?: BacktestScore } = {}): BlendComparison => ({
  overall: { current: score(120, 0.5, null), blend: o.overall ?? score(120, 1, 0.8) },
  byHistory: [],
  byCurrentSource: [
    { source: 'neighbours', current: score(70, 1, null), blend: o.neighbours ?? score(70, 0.95, 0.88) },
    { source: 'bucket', current: score(50, 0.3, null), blend: o.bucket ?? score(50, 1.1, 0.78) },
  ],
  verdict: o.verdict ?? 'blend_better',
});

const passing = { recent: comparison(), heldOut: comparison({ overall: score(40, 1.15, 0.72) }) };
const go: TaskEstimatesRolloutPin = { verdict: 'go', estimatorVersion: ESTIMATOR_VERSION, measuredOn: '2026-11-01', readoutRef: 'x', failing: [] };

describe('evaluateTaskEstimatesGate', () => {
  it('go only when every check passes', () => {
    const r = evaluateTaskEstimatesGate(passing);
    expect(r.verdict).toBe('go');
    expect(r.checks.map(c => c.id)).toEqual(['blend_better', 'neighbours', 'prior_only', 'cold_start']);
  });

  it('a prior that runs about 2x short fails prior_only', () => {
    const r = evaluateTaskEstimatesGate({ ...passing, recent: comparison({ bucket: score(48, 1.9, 0.52) }) });
    expect(r.verdict).toBe('no_go');
    expect(r.checks.filter(c => !c.passed).map(c => c.id)).toEqual(['prior_only']);
  });

  it('unbiased but too narrow fails on p80 coverage', () => {
    const r = evaluateTaskEstimatesGate({ ...passing, recent: comparison({ neighbours: score(70, 1, 0.6) }) });
    expect(r.checks.find(c => c.id === 'neighbours')!.reason).toContain('within p80');
  });

  it('missing evidence fails: no held-out run means no cold-start pass', () => {
    const r = evaluateTaskEstimatesGate({ recent: passing.recent, heldOut: null });
    expect(r.verdict).toBe('no_go');
    expect(r.checks.find(c => c.id === 'cold_start')!.reason).toContain('not measured');
  });

  it('too few scored tasks is not measured, even if the figures look good', () => {
    const r = evaluateTaskEstimatesGate({ ...passing, heldOut: comparison({ overall: score(5, 1, 1) }) });
    expect(r.checks.find(c => c.id === 'cold_start')!.passed).toBe(false);
  });

  it('a blend that is not better fails', () => {
    expect(evaluateTaskEstimatesGate({ ...passing, recent: comparison({ verdict: 'no_better' }) }).verdict).toBe('no_go');
  });
});

describe('the pinned default', () => {
  it('ships off: the last measurement did not pass', () => {
    expect(TASK_ESTIMATES_ROLLOUT.verdict).toBe('no_go');
    expect(taskEstimatesDefaultOn()).toBe(false);
    expect(defaultOffReason()).toContain('little history');
  });

  it('a go pin turns the default on', () => {
    expect(taskEstimatesDefaultOn(go)).toBe(true);
    expect(defaultOffReason(go)).toBeNull();
  });

  it('a go measured on another estimator version does not count', () => {
    expect(taskEstimatesDefaultOn({ ...go, estimatorVersion: 'blend-v0' })).toBe(false);
    expect(defaultOffReason({ ...go, estimatorVersion: 'blend-v0' })).toContain('not been checked');
  });
});

describe('resolveTaskEstimatesState', () => {
  it('new and legacy teams (NULL) follow the default, both ways', () => {
    for (const raw of [null, undefined, {}, { setBy: 'u' }]) {
      expect(resolveTaskEstimatesState(raw, false)).toEqual({ enabled: false, source: 'default', defaultOn: false });
      expect(resolveTaskEstimatesState(raw, true)).toEqual({ enabled: true, source: 'default', defaultOn: true });
    }
  });

  it('an explicit opt-out stays off when the default is on', () => {
    expect(resolveTaskEstimatesState({ enabled: false, setBy: 'u', setAt: 't' }, true)).toEqual({ enabled: false, source: 'team', defaultOn: true });
  });

  it('an explicit opt-in stays on when the default is off', () => {
    expect(resolveTaskEstimatesState({ enabled: true }, false)).toEqual({ enabled: true, source: 'team', defaultOn: false });
  });

  it('a malformed value is not a choice', () => {
    for (const raw of [{ enabled: 1 }, { enabled: 'true' }, [true], 'enabled']) {
      expect(resolveTaskEstimatesState(raw, true).source).toBe('default');
      expect(resolveTaskEstimatesState(raw, false).enabled).toBe(false);
    }
  });
});
