import { describe, expect, it } from 'bun:test';
import { missionDeliveryFacts } from './mission-delivery-facts';

const NOW = Date.parse('2026-10-01T12:00:00Z');

describe('missionDeliveryFacts: one set of facts for the list and Home cards', () => {
  it('names the one open required check and carries the review summary through', () => {
    const f = missionDeliveryFacts({
      status: 'active', executor: 'runner', isHeld: false, integrationBranchEnabled: false, workingBranch: null,
      goalCriteria: [{ type: 'description', description: 'Admin audit log spec holds', label: 'Admin audit log spec', notMechanizableReason: 'judged by reading' }],
      goalCriteriaState: null,
      tasks: [],
    }, { status: 'queued', blockedDetail: null, holdReason: 'budget_paused' }, NOW);
    expect(f.criteriaPending).toBe(1);
    expect(f.criteriaPendingLabel).toBe('Admin audit log spec');
    expect(f.visualReview?.status).toBe('queued');
    expect(f.missionPrMerged).toBe(false);
  });
  it('no criteria: nothing pending, no label', () => {
    const f = missionDeliveryFacts({ status: 'active', tasks: [] }, null, NOW);
    expect(f).toMatchObject({ criteriaPending: 0, criteriaPendingLabel: null, visualReview: null });
  });
});
