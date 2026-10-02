import { describe, expect, it } from 'bun:test';
import { attachQuestionGate } from './question-gate';

const ARM = { experimentId: 'e', policyVersion: 3, arm: 'treatment' as const, propensity: 0.5, apply: true, minConfidence: 0.7, maxPushbacks: 2, minSamplePerArm: 20 };
const claimed = () => [{ id: 'w', taskId: 't', branch: 'b', task: { id: 't', workspace: { teamId: 'team' } } }] as any[];

describe('attachQuestionGate', () => {
  it('marks the worker when the runner supports it and the team runs the experiment', async () => {
    const cws = claimed();
    await attachQuestionGate(cws, { features: ['question_gate'] }, { resolveArm: async () => ARM });
    expect(cws[0].questionGate).toEqual({ experimentId: 'e', policyVersion: 3, arm: 'treatment', maxPushbacks: 2 });
  });

  it('off by default: no experiment, or an older runner, means no marker', async () => {
    const a = claimed();
    await attachQuestionGate(a, { features: ['question_gate'] }, { resolveArm: async () => null });
    expect(a[0].questionGate).toBeUndefined();
    const b = claimed();
    await attachQuestionGate(b, { features: ['cbm_withhold'] }, { resolveArm: async () => { throw new Error('must not look up'); } });
    expect(b[0].questionGate).toBeUndefined();
  });

  it('never throws', async () => {
    const cws = claimed();
    await attachQuestionGate(cws, { features: ['question_gate'] }, { resolveArm: async () => { throw new Error('db down'); } });
    expect(cws[0].questionGate).toBeUndefined();
  });
});
