/**
 * Task a90fc99b: a stuck PR the escalation gate gives to Buildd gets the named
 * next step from the kernel itself, instead of waiting for a person.
 *  - a review or policy escalation with red CI gets its CI fix (T10);
 *  - one that conflicts or collides on a migration number gets the repair (T12);
 *  - a treadmill cycle the sweep restarts is a quiet wait, only the last pages;
 *  - a false success (unproven) does not spend a repair budget, up to an allowance;
 *  - the policy-merge rule approves exactly the head it saw (PolicyMergeApproved).
 */
import { describe, expect, test } from 'bun:test';
import type { ApplyDecision, Command, Decision } from './commands';
import { UNPROVEN_ATTEMPT_ALLOWANCE, headCoverage, ledgerBudget, reduce } from './reducer';
import type { AttemptSnapshot, DeliverySnapshot, KernelView } from './types';

const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
  state: 'ESCALATED', stateReason: 'review_escalated', version: 5, currentHeadSha: 'H1', currentRound: 1, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const A = (o: Partial<AttemptSnapshot> = {}): AttemptSnapshot => ({
  id: 'a1', family: 'ci', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: 'sig', taskId: 'ft1',
  status: 'ended', outcome: 'failed', maxAttempts: 3, reportedShas: [], ...o,
});
const V = (d: DeliverySnapshot, attempts: AttemptSnapshot[] = []): KernelView => ({ delivery: d, rounds: [], attempts });
let seq = 0;
const run = (v: KernelView, cmd: Command): Decision => reduce(v, cmd, { newId: () => `id${++seq}` });
function applied(dec: Decision): ApplyDecision {
  if (dec.result !== 'apply') throw new Error(`expected apply, got ${dec.result}: ${(dec as { reason?: string }).reason}`);
  return dec;
}
const reason = (dec: Decision) => ({ result: dec.result, reason: (dec as { reason?: string }).reason });
const kinds = (d: ApplyDecision) => d.effects.map((e) => e.kind);
const ciRed = (v: KernelView) => run(v, { type: 'CiFailedObserved', actor: 'sweep:ci-red', headSha: 'H1', signature: 'sig', maxAttempts: 3 });

describe('T10: red CI on an escalated PR is fixed before a person decides', () => {
  test.each(['review_escalated', 'review_exhausted', 'policy_human'])('ESCALATED(%s) → REPAIRING(ci) with a CI fix dispatched', (why) => {
    const dec = applied(ciRed(V(D({ stateReason: why }))));
    expect(dec.toState).toBe('REPAIRING');
    expect(dec.patch.stateReason).toBe('ci');
    expect(kinds(dec)).toContain('dispatch_ci_fix');
  });

  test.each(['landing_needs_human', 'ci_exhausted', 'conflict_exhausted', 'push_undeliverable'])('ESCALATED(%s) is still a person\'s: nothing dispatched', (why) => {
    expect(ciRed(V(D({ stateReason: why })))).toMatchObject({ result: 'stale', reason: 'state_not_allowed' });
  });

  test('a spent CI budget does not overwrite why it escalated', () => {
    const spent = [1, 2, 3].map((n) => A({ id: `c${n}`, attemptNo: n }));
    expect(reason(ciRed(V(D(), spent)))).toEqual({ result: 'rejected', reason: 'budget_exhausted' });
  });
});

describe('T12: a conflict or a migration collision on an escalated PR is repaired first', () => {
  const conflict = (v: KernelView, o: Partial<Extract<Command, { type: 'ConflictObserved' }>> = {}) =>
    run(v, { type: 'ConflictObserved', actor: 'door:conflict', headSha: 'H1', mergeable: 'dirty', maxAgentAttempts: 3, ...o });

  test('a migration number collision → a mechanical renumber', () => {
    const dec = applied(conflict(V(D()), { migrationCollision: true, detail: { migrationCollision: { file: '0281_a.sql', otherFile: '0281_b.sql', otherPrNumber: 6 } } }));
    expect(dec.toState).toBe('REPAIRING');
    expect(kinds(dec)).toContain('renumber_migration');
  });

  test('a dirty PR → the conflict repair', () => {
    expect(applied(conflict(V(D({ stateReason: 'policy_human' })))).toState).toBe('REPAIRING');
  });

  test('behind only: no refresh for a PR nothing will land yet', () => {
    expect(reason(conflict(V(D()), { mergeable: 'behind' }))).toEqual({ result: 'stale', reason: 'state_not_allowed' });
  });

  test('a landing hand-off is still a person\'s', () => {
    expect(reason(conflict(V(D({ stateReason: 'landing_needs_human' })), { migrationCollision: true }))).toEqual({ result: 'stale', reason: 'state_not_allowed' });
  });
});

describe('S15: a treadmill cycle the sweep restarts is a quiet wait', () => {
  const behind = (from: number, n: number) => Array.from({ length: n }, (_, i) => A({ id: `m${from + i}`, family: 'conflict', mode: 'mechanical', attemptNo: from + i, boundHeadSha: `B${from + i}`, triggerReason: 'behind', taskId: null }));
  const marker = (no: number) => A({ id: `cyc${no}`, family: 'conflict', mode: 'mechanical', attemptNo: no, boundHeadSha: null, triggerReason: 'treadmill_cycle', status: 'skipped', outcome: null, taskId: null });
  const mc = (rows: AttemptSnapshot[]) => applied(run(V(D({ state: 'LANDING', stateReason: null, approvedHeads: ['H1'], approvalBasis: 'verdict' }), rows), { type: 'MergeCallResult', actor: 'kernel', headSha: 'H1', outcome: 'behind' }));

  test('cycle 1 escalates without a notify (the sweep restarts it after the cooldown)', () => {
    const dec = mc(behind(1, 3));
    expect(dec.toState).toBe('ESCALATED');
    expect(kinds(dec)).not.toContain('notify');
  });

  test('the last cycle notifies a person', () => {
    const dec = mc([...behind(1, 3), marker(4), ...behind(5, 3), marker(8), ...behind(9, 3)]);
    expect(dec.evidence).toMatchObject({ finalCycle: true });
    expect(kinds(dec)).toContain('notify');
  });
});

describe('§5.7 rule 1: a false success does not spend a repair budget', () => {
  const rows = (unproven: number, failed: number) => [
    ...Array.from({ length: unproven }, (_, i) => A({ id: `u${i}`, attemptNo: i + 1, outcome: 'unproven' })),
    ...Array.from({ length: failed }, (_, i) => A({ id: `f${i}`, attemptNo: unproven + i + 1, outcome: 'failed' })),
  ];

  test('unproven ends up to the allowance are free', () => {
    expect(ledgerBudget(rows(UNPROVEN_ATTEMPT_ALLOWANCE, 1), 'ci', 3).spent).toBe(1);
  });

  test('past the allowance they count, so a loop still ends', () => {
    expect(ledgerBudget(rows(UNPROVEN_ATTEMPT_ALLOWANCE + 2, 0), 'ci', 3).spent).toBe(2);
  });

  test('a delivered or failed attempt always counts', () => {
    expect(ledgerBudget([A({ outcome: 'delivered' }), A({ id: 'a2', attemptNo: 2 })], 'ci', 3).spent).toBe(2);
  });

  test('T10 dispatches again after two false successes on a cap of 3 with one real try', () => {
    const v = V(D({ state: 'AWAITING_REVIEW', stateReason: null }), rows(2, 1));
    expect(applied(ciRed(v)).toState).toBe('REPAIRING');
  });
});

describe('PolicyMergeApproved: the policy-merge rule approves exactly the head it saw', () => {
  const pm = (v: KernelView, o: Partial<Extract<Command, { type: 'PolicyMergeApproved' }>> = {}) =>
    run(v, { type: 'PolicyMergeApproved', actor: 'rule:escalation_gate', headSha: 'H1', reason: 'policy-only, gates hold', ...o });

  test('ESCALATED(review_escalated) → APPROVED on basis policy_rule, recorded as a bypass', () => {
    const dec = applied(pm(V(D())));
    expect(dec.toState).toBe('APPROVED');
    expect(dec.patch).toMatchObject({ approvalBasis: 'policy_rule', approvedHeads: ['H1'], stateReason: null });
    expect(dec.bypass).toMatchObject({ actor: 'rule:escalation_gate', overrodeReason: 'review_escalated' });
    // The normal landing doors take it from APPROVED; no merge call from here.
    expect(kinds(dec)).not.toContain('merge_call');
  });

  test('only that head is covered: a later push is not', () => {
    const d = D({ approvedHeads: ['H1'], approvalBasis: 'policy_rule' });
    expect(headCoverage(d, 'H1')).not.toBe('none');
    expect(headCoverage({ ...d, currentHeadSha: 'H2' }, 'H2')).toBe('none');
  });

  test('refusals', () => {
    expect(reason(pm(V(D()), { actor: 'jev' }))).toEqual({ result: 'rejected', reason: 'rule_actor_required' });
    expect(reason(pm(V(D()), { actor: 'human:u' }))).toEqual({ result: 'rejected', reason: 'rule_actor_required' });
    expect(reason(pm(V(D({ state: 'AWAITING_REVIEW' }))))).toEqual({ result: 'stale', reason: 'state_not_allowed' });
    expect(reason(pm(V(D({ stateReason: 'landing_needs_human' }))))).toEqual({ result: 'rejected', reason: 'escalation_not_policy_mergeable' });
    expect(reason(pm(V(D({ stateReason: 'ci_exhausted' }))))).toEqual({ result: 'rejected', reason: 'escalation_not_policy_mergeable' });
    expect(reason(pm(V(D()), { headSha: 'H0' }))).toEqual({ result: 'stale', reason: 'head_not_current' });
    expect(reason(pm(V(D({ stateReason: 'policy_human', policyEvidence: { headSha: 'H1', outcome: 'human', reason: 'drops a column', destructive: true } }))))).toEqual({ result: 'rejected', reason: 'destructive_migration' });
  });
});
