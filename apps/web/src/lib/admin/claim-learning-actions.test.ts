import { describe, expect, test } from 'bun:test';
import { handleClaimLearningAction } from './claim-learning-actions';

const owner = { accountId: 'owner', operatorLabel: 'operator' };
const request = { capability: 'claim_learning_revert', gate: 'advisory', area: 'other', expectedRevision: 2, reason: 'Safety review' };
function setup() {
  const events: string[] = [];
  return { events, deps: {
    change: async (_input: unknown) => { events.push('change'); return { status: 'applied', revision: 3 }; },
    auditIntent: async (_event: unknown) => { events.push('intent'); return 'audit'; },
    auditComplete: async (_id: string, _after: unknown) => { events.push('complete'); return true; },
  } };
}
describe('claim learning owner actions', () => {
  test('requires reason and revision before writing anything', async () => {
    const { deps, events } = setup();
    expect((await handleClaimLearningAction(deps, owner, { ...request, reason: '' })).status).toBe(400);
    expect((await handleClaimLearningAction(deps, owner, { ...request, expectedRevision: undefined })).status).toBe(400);
    expect(events).toEqual([]);
  });
  test('audits intent before policy change and completion before success', async () => {
    const { deps, events } = setup();
    expect((await handleClaimLearningAction(deps, owner, request)).status).toBe(200);
    expect(events).toEqual(['intent', 'change', 'complete']);
  });
  test('failed audit intent prevents policy change', async () => {
    const { deps, events } = setup();
    deps.auditIntent = async () => { throw new Error('unavailable'); };
    expect((await handleClaimLearningAction(deps, owner, request)).status).toBe(500);
    expect(events).toEqual([]);
  });
  test('audit completion failure does not report applied', async () => {
    const { deps } = setup();
    deps.auditComplete = async () => false;
    expect((await handleClaimLearningAction(deps, owner, request)).status).toBe(500);
  });
  test('stale revision returns conflict and remains audited', async () => {
    const { deps, events } = setup();
    deps.change = async () => { events.push('change'); return { status: 'stale', revision: 3 }; };
    expect((await handleClaimLearningAction(deps, owner, request)).status).toBe(409);
    expect(events).toEqual(['intent', 'change', 'complete']);
  });
  test('rejects out of range delta and pin fraction', async () => {
    const { deps, events } = setup();
    expect((await handleClaimLearningAction(deps, owner, { ...request, capability: 'claim_learning_set_delta', delta: -1 })).status).toBe(400);
    expect((await handleClaimLearningAction(deps, owner, { ...request, capability: 'claim_learning_pin', fraction: 2 })).status).toBe(400);
    expect(events).toEqual([]);
  });
});
