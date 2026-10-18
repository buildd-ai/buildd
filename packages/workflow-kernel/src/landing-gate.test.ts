/**
 * The landing gate and the `buildd/landing` status it publishes
 * (docs/specs/workflow-kernel-library.md §4; workflow-state-kernel.md §13.13
 * rules 6 and 7). Pure: the same answer the merge effect asks at merge time
 * and the status puts on the head.
 */
import { describe, expect, test } from 'bun:test';
import { LANDING_STATUS_CONTEXT, LANDING_STATUS_CONTEXTS, landingStatusOf, landingStatusUnknown, reviewGate } from './landing-gate';
import { openVerdict } from './reducer';
import type { DeliverySnapshot, KernelView, RoundSnapshot } from './types';

const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
  state: 'APPROVED', stateReason: null, version: 5, currentHeadSha: 'abcdef1234', currentRound: 1, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: ['abcdef1234'], approvalBasis: 'verdict',
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const R = (round: number, verdict: RoundSnapshot['verdict'], o: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  id: `r${round}`, round, headSha: 'abcdef1234', kind: 'full', status: 'decided', verdict, effectiveVerdict: verdict, failureCount: 0, ...o,
});
const V = (d: DeliverySnapshot | null, rounds: RoundSnapshot[] = []): KernelView => ({ delivery: d, rounds, attempts: [] });

describe('openVerdict: the newest decided round, while it stands against landing', () => {
  test('a later approve closes an earlier request for changes; undecided rounds do not count', () => {
    expect(openVerdict(V(D(), [R(1, 'request_changes')]))?.round).toBe(1);
    expect(openVerdict(V(D(), [R(1, 'request_changes'), R(2, 'approve')]))).toBeNull();
    expect(openVerdict(V(D(), [R(1, 'approve'), R(2, 'escalate')]))?.round).toBe(2);
    expect(openVerdict(V(D(), [R(1, 'request_changes'), R(2, null, { status: 'queued' })]))?.round).toBe(1);
    expect(openVerdict(V(D(), []))).toBeNull();
  });
});

describe('reviewGate (§13.13 rule 6)', () => {
  test('approved and covered at the head, nothing open: lands', () => {
    expect(reviewGate(V(D(), [R(1, 'approve')]))).toEqual({ ok: true, coverage: 'verdict', overridden: false });
  });
  test('a head other than the current one, or a state that is not landing, never lands', () => {
    expect(reviewGate(V(D()), { headSha: 'ffff' })).toMatchObject({ ok: false, blocker: 'head_moved' });
    expect(reviewGate(V(D({ state: 'AWAITING_REVIEW' })))).toMatchObject({ ok: false, blocker: 'not_approved' });
    expect(reviewGate(V(D({ state: 'APPROVED' })), { states: ['LANDING'] })).toMatchObject({ ok: false, blocker: 'not_approved' });
  });
  test('no review covering the head: refused, unless a person overrode the verdict', () => {
    const d = D({ state: 'LANDING', approvedHeads: [], approvalBasis: null });
    expect(reviewGate(V(d), { states: ['LANDING'] })).toMatchObject({ ok: false, blocker: 'review_missing' });
    expect(reviewGate(V(d), { states: ['LANDING'], verdictOverride: true })).toMatchObject({ ok: true, overridden: true });
  });
  test('an open request for changes blocks even a covered head; a person\'s approval passes it; the policy rule passes only an escalation', () => {
    const rc = [R(1, 'approve'), R(2, 'request_changes')];
    expect(reviewGate(V(D(), rc))).toMatchObject({ ok: false, blocker: 'open_verdict', reason: 'review round 2 asked for changes at abcdef1' });
    expect(reviewGate(V(D({ approvalBasis: 'human' }), rc))).toMatchObject({ ok: true });
    expect(reviewGate(V(D({ approvalBasis: 'policy_rule' }), rc))).toMatchObject({ ok: false, blocker: 'open_verdict' });
    expect(reviewGate(V(D({ approvalBasis: 'policy_rule' }), [R(1, 'escalate')]))).toMatchObject({ ok: true });
  });
});

describe('landingStatusOf: the buildd/landing status (§4)', () => {
  test('the context is Buildd / Review approval, also published under the legacy name', () => {
    expect(LANDING_STATUS_CONTEXT).toBe('Buildd / Review approval');
    expect(LANDING_STATUS_CONTEXTS).toEqual(['buildd/landing', 'Buildd / Review approval']);
  });
  test('review still running is pending, not failure; a finding or verdict against the head stays failure', () => {
    for (const state of ['WORKING', 'AWAITING_PUSH', 'AWAITING_REVIEW'] as const) {
      expect(landingStatusOf(V(D({ state, approvedHeads: [] })))!.state).toBe('pending');
    }
    expect(landingStatusOf(V(D({ state: 'AWAITING_REVIEW', approvedHeads: [] })))!.description).toContain('Review in progress');
  });
  test('success only when the kernel would land the head; the description names it by short sha', () => {
    const status = landingStatusOf(V(D(), [R(1, 'approve')]));
    expect(status).toMatchObject({ state: 'success', sha: 'abcdef1234' });
    expect(status!.description).toContain('Ready to merge');
    expect(status!.description).not.toContain('land');
    expect(landingStatusOf(V(D({ state: 'LANDING' }), [R(1, 'approve')]))!.state).toBe('success');
  });
  test('failure while a verdict is open, or the delivery is anywhere else', () => {
    const failed = landingStatusOf(V(D(), [R(1, 'approve'), R(2, 'request_changes')]));
    expect(failed!.description).toContain('Changes requested');
    expect(failed!.description).not.toContain('land');
    expect(landingStatusOf(V(D({ state: 'ESCALATED', stateReason: 'review_exhausted' })))!.description).toContain('Merge blocked');
    expect(landingStatusOf(V(D({ state: 'CHANGES_REQUESTED' })))!.state).toBe('failure');
  });
  test('a lasting rail\'s refusal is named while a person decides it', () => {
    const status = landingStatusOf(V(D({ state: 'ESCALATED', stateReason: 'landing_needs_human' })), { detail: 'touches protected path (infra/x)' });
    expect(status!.description).toContain('Merge blocked');
    expect(status!.description).toContain('protected path');
    expect(status!.description).not.toContain('land');
    // Only while escalated: a detail never turns into a reason for a delivery that moved on.
    expect(landingStatusOf(V(D(), [R(1, 'approve')]), { detail: 'touches protected path (infra/x)' })!.state).toBe('success');
  });
  test('nothing to publish without a PR head, or once the delivery is over', () => {
    expect(landingStatusOf(V(D({ currentHeadSha: null })))).toBeNull();
    expect(landingStatusOf(V(D({ prNumber: null })))).toBeNull();
    for (const state of ['MERGED', 'CLOSED_UNMERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED'] as const) expect(landingStatusOf(V(D({ state })))).toBeNull();
  });
  test('descriptions fit GitHub\'s 140 characters and carry no full sha', () => {
    const long = landingStatusOf(V(D({ state: 'ESCALATED', stateReason: 'x'.repeat(300) })))!;
    expect(long.description.length).toBeLessThanOrEqual(140);
    expect(long.description).not.toContain('abcdef1234');
  });
  test('the exhaustion answer is failure, never success, and says what to do', () => {
    const status = landingStatusUnknown('abcdef1234');
    expect(status.state).toBe('failure');
    expect(status.description).toContain('Merge blocked');
    expect(status.description).toContain('ready to merge');
    expect(status.description).not.toContain('land');
  });
});

describe('reviewGate with findings (workflow-kernel-library.md §5, AC-13)', () => {
  const F = (o: Partial<import('./types').FindingSnapshot> = {}): import('./types').FindingSnapshot => ({
    id: 'r1:0', originRoundId: 'r1', originRound: 1, originHeadSha: 'abcdef1234', ordinal: 0, path: 'src/a.ts', line: 4,
    title: 'rename the flag', required: true, status: 'open', lastRound: 1, addressedBySha: null, closedByRoundId: null,
    closedBy: null, closedReason: null, deferredToTaskId: null, ...o,
  });
  const VF = (d: DeliverySnapshot, findings: import('./types').FindingSnapshot[]): KernelView => ({ delivery: d, rounds: [R(1, 'approve')], attempts: [], findings });

  test('an open or addressed required finding blocks a covered, approved head, named, whatever the state', () => {
    expect(reviewGate(VF(D(), [F()]))).toMatchObject({ ok: false, blocker: 'open_finding', reason: 'open finding src/a.ts:4: rename the flag' });
    expect(reviewGate(VF(D(), [F({ status: 'addressed' }), F({ id: 'r1:1', path: null, title: 'add a test' })]))).toMatchObject({ ok: false, blocker: 'open_finding', reason: 'open finding src/a.ts:4: rename the flag (and 1 more)' });
    expect(reviewGate(VF(D({ state: 'AWAITING_REVIEW' }), [F()]))).toMatchObject({ blocker: 'open_finding' });
  });
  test('a closed or optional finding never blocks', () => {
    for (const status of ['resolved', 'waived', 'deferred'] as const) expect(reviewGate(VF(D(), [F({ status })])).ok).toBe(true);
    expect(reviewGate(VF(D(), [F({ required: false })])).ok).toBe(true);
  });
  test('only a person passes it: their verdict override, or their own approval of this head; never the policy rule', () => {
    expect(reviewGate(VF(D(), [F()]), { verdictOverride: true }).ok).toBe(true);
    expect(reviewGate(VF(D({ approvalBasis: 'human' }), [F()])).ok).toBe(true);
    expect(reviewGate(VF(D({ approvalBasis: 'human', approvedHeads: ['older'] }), [F()]))).toMatchObject({ blocker: 'open_finding' });
    expect(reviewGate(VF(D({ approvalBasis: 'policy_rule' }), [F()]))).toMatchObject({ blocker: 'open_finding' });
  });
  test('buildd/landing is failure at the head, naming the finding', () => {
    expect(landingStatusOf(VF(D(), [F()]))).toEqual({ state: 'failure', sha: 'abcdef1234', description: 'Unresolved review finding: src/a.ts:4: rename the flag' });
  });
});
