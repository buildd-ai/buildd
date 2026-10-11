/**
 * The approved-merge rule (the reviews module's half of the delivery-view
 * slot): an APPROVED delivery waits on a person only when the effective merge
 * policy for that PR leaves the merge to one.
 */
import { describe, expect, test } from 'bun:test';
import { approvedNeedsPerson } from './merge-policy-approved';
import { rowToDeliveryView } from './workflow/delivery-view';

describe('approvedNeedsPerson: who merges an APPROVED delivery', () => {
  const delivery = { id: 'd1', workspace_id: 'w1', owner_task_id: 't1', pr_number: 7, base_ref: 'dev', state: 'APPROVED', version: 4, current_head_sha: 'H1', current_round: 1, max_rounds: 3, approved_heads: ['H1'], composition_heads: [] };
  const withPolicy = (mergePolicy: unknown, owner: Record<string, unknown> = {}, mode = 'enforce') => ({
    delivery, workspace: { git_config: { mergePolicy, landing: { mode } } }, owner_task: owner,
  });
  test('human tier needs a person', () => expect(approvedNeedsPerson(withPolicy({ tier: 'human' }))).toBe(true));
  test('agent-review approve-and-merge lands without one', () => expect(approvedNeedsPerson(withPolicy({ tier: 'agent-review' }))).toBe(false));
  test('agent-review approve-only needs a person', () =>
    expect(approvedNeedsPerson(withPolicy({ tier: 'agent-review', agentReview: { reviewerRole: 'reviewer', gateCondition: 'approve-only' } }))).toBe(true));
  test('auto-threshold lands without one', () => expect(approvedNeedsPerson(withPolicy({ tier: 'auto-threshold' }))).toBe(false));
  test('an open landing handoff (escalate path) at the current head needs a person', () => {
    const handoff = { prNumber: 7, headSha: 'H1', cause: 'x', reason: 'r' };
    expect(approvedNeedsPerson(withPolicy({ tier: 'agent-review' }, { landing_handoff: handoff }))).toBe(true);
    expect(approvedNeedsPerson(withPolicy({ tier: 'agent-review' }, { landing_handoff: { ...handoff, headSha: 'OLD' } }))).toBe(false);
  });
  test('a task flagged requiresReview needs a person', () =>
    expect(approvedNeedsPerson(withPolicy({ tier: 'auto-threshold' }, { requires_review: true }))).toBe(true));
  test('a mission that requires review gates its PR on a person', () =>
    expect(approvedNeedsPerson(withPolicy({ tier: 'agent-review' }, { mission: { merge_policy: null, requires_review: true, working_branch: null, integration_branch_enabled: false } }))).toBe(true));
  test('a task PR into its mission integration branch lands; the mission PR into trunk is the gate', () => {
    const mission = { merge_policy: null, requires_review: true, working_branch: 'mission/x-1234abcd', integration_branch_enabled: true };
    expect(approvedNeedsPerson({ ...withPolicy({ tier: 'agent-review' }, { mission }), delivery: { ...delivery, base_ref: 'mission/x-1234abcd' } })).toBe(false);
    expect(approvedNeedsPerson({ ...withPolicy({ tier: 'agent-review' }, { mission }), delivery: { ...delivery, base_ref: 'dev' } })).toBe(true);
  });
  test('the row maps to owner human vs landing through the slot', () => {
    const base = { rounds: [], attempts: [], attempt_tasks: [], remediation: null };
    expect(rowToDeliveryView({ ...base, ...withPolicy({ tier: 'human' }) }, Date.now(), approvedNeedsPerson)).toMatchObject({ owner: 'human', needsYou: true });
    expect(rowToDeliveryView({ ...base, ...withPolicy({ tier: 'agent-review' }) }, Date.now(), approvedNeedsPerson)).toMatchObject({ owner: 'landing', needsYou: false });
  });
});
