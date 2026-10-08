import { describe, expect, it } from 'bun:test';
import { attachQuestionGate } from './question-gate';

const claimed = () => [{ id: 'w', taskId: 't', branch: 'b', task: { id: 't', workspace: { teamId: 'team' } } }] as any[];

describe('attachQuestionGate', () => {
  it('marks every claimed worker when the runner supports the feature', () => {
    const cws = claimed();
    attachQuestionGate(cws, { features: ['question_gate'] });
    expect(cws[0].questionGate).toEqual({ maxPushbacks: 2 });
  });

  it('an older runner with no feature gets no marker', () => {
    const cws = claimed();
    attachQuestionGate(cws, { features: ['agent_endpoint'] });
    expect(cws[0].questionGate).toBeUndefined();
  });

  it('no features at all: no marker', () => {
    const cws = claimed();
    attachQuestionGate(cws, { features: undefined });
    expect(cws[0].questionGate).toBeUndefined();
  });
});
