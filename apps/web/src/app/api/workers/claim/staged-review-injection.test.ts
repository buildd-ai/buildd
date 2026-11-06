import { describe, test, expect } from 'bun:test';
import { buildStagedAssignment, withStagedExperiment, STAGED_EXPERIMENT_KIND } from './staged-review-injection';
import { resolveStagedConfig } from '../../../../../../runner/src/staged-self-review';

import { STAGED_SELF_REVIEW_FEATURE } from '@buildd/core/staged-self-review';

test('experiment kind mirrors the core constant', () => {
  expect(STAGED_EXPERIMENT_KIND).toBe(STAGED_SELF_REVIEW_FEATURE);
});

const exp = { id: 'exp-1', policyVersion: 2, treatmentFraction: 0.5 };

describe('withStagedExperiment', () => {
  test('off or unset selfReview: workspace returned untouched', () => {
    const off = { gitConfig: { selfReview: 'off' } };
    const none = { gitConfig: {} };
    expect(withStagedExperiment(off, exp)).toBe(off);
    expect(withStagedExperiment(none, exp)).toBe(none);
  });
  test('no running experiment: untouched', () => {
    const ws = { gitConfig: { selfReview: 'acting' } };
    expect(withStagedExperiment(ws, null)).toBe(ws);
  });
  test('acting attaches the experiment, with checklist pin when configured', () => {
    const out = withStagedExperiment({ gitConfig: { selfReview: 'acting' } }, { ...exp, config: { checklistVersion: 'v1' } });
    expect(out.gitConfig.selfReviewExperiment).toEqual({ id: 'exp-1', policyVersion: 2, treatmentFraction: 0.5, checklistVersion: 'v1' });
  });
  test('acting + experiment: the runner draws an arm with propensity; control sees no stage', () => {
    const ws = withStagedExperiment({ gitConfig: { selfReview: 'acting' } }, exp);
    const arms = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const r = resolveStagedConfig(ws.gitConfig, `task-${i}`);
      expect(r.mode).toBe('acting');
      expect(r.propensity).toBeCloseTo(0.5);
      arms.add(r.arm);
    }
    expect(arms).toEqual(new Set(['control', 'treatment']));
  });
  test('recording never gets a treatment arm', () => {
    const ws = withStagedExperiment({ gitConfig: { selfReview: 'recording' } }, exp);
    for (let i = 0; i < 30; i++) expect(resolveStagedConfig(ws.gitConfig, `t-${i}`).arm).toBe('control');
  });
});

describe('buildStagedAssignment', () => {
  const acting = withStagedExperiment({ gitConfig: { selfReview: 'acting' } }, exp);
  test('matches the runner draw, with propensity and version', () => {
    for (let i = 0; i < 30; i++) {
      const row = buildStagedAssignment(acting, `task-${i}`)!;
      const r = resolveStagedConfig(acting.gitConfig, `task-${i}`);
      expect(row.arm).toBe(r.arm);
      expect(row.propensity).toBe(r.propensity!);
      expect(row.policyVersion).toBe(2);
      expect(row.served).toBe(r.arm === 'treatment');
    }
  });
  test('no experiment, recording or off: nothing recorded', () => {
    expect(buildStagedAssignment({ gitConfig: { selfReview: 'acting' } }, 't')).toBeNull();
    expect(buildStagedAssignment(withStagedExperiment({ gitConfig: { selfReview: 'recording' } }, exp), 't')).toBeNull();
    expect(buildStagedAssignment({ gitConfig: {} }, 't')).toBeNull();
  });
});
