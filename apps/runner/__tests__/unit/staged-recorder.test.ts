import { describe, test, expect } from 'bun:test';
import { createStagedRecorder } from '../../src/staged-self-review';

describe('createStagedRecorder', () => {
  test('persists every field of each entry in order, with a pointer milestone', () => {
    const worker: { stagedSelfReview?: Array<Record<string, unknown>> } = {};
    const ms: any[] = [];
    const rec = createStagedRecorder(worker, m => ms.push(m), () => 42);
    rec({ mode: 'acting', arm: 'treatment', exemption: null, outcome: 'denied', propensity: 0.5, checklistVersion: 'intent-v1', itemIds: ['a', 'b'] });
    rec({
      mode: 'acting', arm: 'treatment', exemption: null, outcome: 'answered', answers: [{ id: 'a', answer: 'met' }],
      toolCallsBetween: ['Edit'], addedTurns: 2, addedTokens: 900, workChangedAfterDenial: true,
    });
    expect(worker.stagedSelfReview).toHaveLength(2);
    expect(worker.stagedSelfReview![0]).toMatchObject({ outcome: 'denied', itemIds: ['a', 'b'], ts: 42 });
    expect(worker.stagedSelfReview![1]).toMatchObject({
      outcome: 'answered', toolCallsBetween: ['Edit'], addedTurns: 2, addedTokens: 900, workChangedAfterDenial: true,
    });
    expect(ms.map(m => m.label)).toEqual(['Self-review: denied (treatment, acting)', 'Self-review: answered (treatment, acting)']);
  });
});
