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
    expect(landingStatusOf(V(D({ state: 'AWAITING_REVIEW', approvedHeads: [] })))!.description).toBe('Review in progress: abcdef1 is waiting for its review');
    expect(landingStatusOf(V(D({ state: 'WORKING', approvedHeads: [] })))!.description).toBe('Review in progress: work on the PR is still running');
  });
  test('success only when the kernel would land the head; the description names it by short sha', () => {
    expect(landingStatusOf(V(D(), [R(1, 'approve')]))).toEqual({ state: 'success', sha: 'abcdef1234', description: 'Ready to merge: abcdef1 approved by review' });
    expect(landingStatusOf(V(D({ state: 'LANDING' }), [R(1, 'approve')]))!.state).toBe('success');
  });
  test('failure while a verdict is open, or the delivery is anywhere else', () => {
    expect(landingStatusOf(V(D(), [R(1, 'approve'), R(2, 'request_changes')]))!.description).toBe('Changes requested: review round 2 asked for changes at abcdef1');
    expect(landingStatusOf(V(D({ state: 'CHANGES_REQUESTED' })))!.description).toBe('Changes requested: waiting for a fix to abcdef1');
    expect(landingStatusOf(V(D({ state: 'FIXING' })))!.description).toBe('Changes requested: a fix for abcdef1 is in progress');
    expect(landingStatusOf(V(D({ state: 'BLOCKED_ON_TRUNK' })))!.description).toBe('Merge blocked: the base branch is red');
    expect(landingStatusOf(V(D(), [R(1, 'escalate')]))!.description).toBe('Merge blocked: review round 1 escalated at abcdef1');
    expect(landingStatusOf(V(D({ state: 'ESCALATED', stateReason: 'review_exhausted' })))!.description).toBe('Merge blocked: a person has to decide (review exhausted)');
    expect(landingStatusOf(V(D({ state: 'CHANGES_REQUESTED' })))!.state).toBe('failure');
  });
  test('a lasting rail\'s refusal is named while a person decides it', () => {
    expect(landingStatusOf(V(D({ state: 'ESCALATED', stateReason: 'landing_needs_human' })), { detail: 'touches protected path (infra/x)' })!.description)
      .toBe('Merge blocked: touches protected path (infra/x)');
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
  // What evaluateAutoMergeSafety refuses with (apps/web/src/lib/auto-merge.ts and the rails it calls), as the kernel receives them.
  const RAIL_REASONS = [
    'touches protected path (infra/x)',
    'CI checks still pending or failed: build (in_progress)',
    'auto-threshold tier: diff size 900 source lines > workspace limit 500 (2 noise files excluded)',
    'PR has conflicts (mergeable_state: dirty) — needs rebase onto base branch',
    'PR mixes EXPAND and CONTRACT migrations — split into two PRs: ship additive changes first, then merge the destructive ones separately once nothing reads the old columns. Triggered by: drops a column',
    'migration snapshot parent is no longer a leaf of the base: a migration merged since CI ran, so the earlier green never tested the two together. CI must run again on a fresh base, needs rebase onto base branch',
    'the head is behind its base, but the base delta is small, disjoint from this PR and risk-free (S15); the merge door merges it without another refresh',
  ];
  test('R-43: every description leads with a plain review term and never says "land"', () => {
    const terms = ['Branch update in progress', 'Review in progress', 'Changes requested', 'Unresolved review finding', 'Ready to merge', 'Merge blocked'];
    const F = { id: 'r1:0', originRoundId: 'r1', originRound: 1, originHeadSha: 'abcdef1234', ordinal: 0, path: 'src/a.ts', line: 4, title: 'rename the flag', required: true, status: 'open' as const, lastRound: 1, addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null, deferredToTaskId: null };
    const states: DeliverySnapshot['state'][] = ['WORKING', 'AWAITING_PUSH', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'FIXING', 'APPROVED', 'LANDING', 'REPAIRING', 'BLOCKED_ON_TRUNK', 'ESCALATED'];
    const out: string[] = [landingStatusUnknown('abcdef1234').description];
    for (const state of states) {
      for (const stateReason of [null, 'landing_needs_human', 'landing_refused']) {
        for (const rounds of [[], [R(1, 'approve')], [R(1, 'approve'), R(2, 'request_changes')], [R(1, 'escalate')]]) {
          out.push(landingStatusOf(V(D({ state, stateReason }), rounds))!.description);
          out.push(landingStatusOf({ delivery: D({ state, stateReason }), rounds, attempts: [], findings: [F] })!.description);
          out.push(landingStatusOf(V(D({ state, stateReason, approvedHeads: [] }), rounds))!.description);
          // A rail's refusal, passed through verbatim as the detail (apps/web auto-merge rails;
          // auto-merge-rail-words.test.ts keeps their sources free of "land").
          for (const detail of RAIL_REASONS) out.push(landingStatusOf(V(D({ state, stateReason }), rounds), { detail })!.description);
        }
      }
    }
    for (const desc of out) {
      expect(terms.some((t) => desc.startsWith(`${t}:`))).toBe(true);
      expect(desc).not.toMatch(/\bland/i);
    }
  });
  test('the exhaustion answer is failure, never success, and says what to do', () => {
    expect(landingStatusUnknown('abcdef1234')).toEqual({ state: 'failure', sha: 'abcdef1234', description: 'Merge blocked: buildd could not confirm abcdef1 is ready to merge; ask for a review again or retry the merge' });
  });
});

describe('landingStatusOf while the PR is being repaired (review validity vs landing eligibility)', () => {
  const rep = (o: Partial<DeliverySnapshot> = {}) => D({ state: 'REPAIRING', stateReason: 'behind', ...o });
  test('approved at the head and behind: pending, says the review is approved, never a failure', () => {
    const s = landingStatusOf(V(rep(), [R(1, 'approve')]))!;
    expect(s.state).toBe('pending');
    expect(s.description).toBe('Branch update in progress: review approved abcdef1; the PR is being repaired (behind)');
  });
  test('a new head with no covering review is pending review, not a rejection', () => {
    const s = landingStatusOf(V(rep({ approvedHeads: [], approvalBasis: null }), [R(1, 'approve')]))!;
    expect(s).toMatchObject({ state: 'pending', description: 'Review in progress: no review covers abcdef1 yet' });
  });
  test('a failed review stays a failure while repairing', () => {
    expect(landingStatusOf(V(rep(), [R(1, 'request_changes')]))).toMatchObject({ state: 'failure', description: expect.stringContaining('Changes requested') });
  });
  test('the merge gate still refuses a repairing delivery', () => {
    expect(reviewGate(V(rep(), [R(1, 'approve')]))).toMatchObject({ ok: false, blocker: 'not_approved' });
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
    expect(landingStatusOf(VF(D(), [F(), F({ id: 'r1:1', path: null, title: 'add a test' })]))!.description).toBe('Unresolved review finding: src/a.ts:4: rename the flag (and 1 more)');
  });
});
