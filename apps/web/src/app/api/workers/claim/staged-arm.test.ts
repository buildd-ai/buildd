import { describe, test, expect } from 'bun:test';
import { withStagedExperiment } from './staged-arm';
import { resolveStagedConfig } from '../../../../../../runner/src/staged-self-review';

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
