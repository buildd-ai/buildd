/**
 * The transition table (docs/specs/workflow-state-kernel.md §6) as a matrix.
 * Every command has an applied case; the generic block then proves, for each
 * of them, the CAS guard (§7.1/7.3), the stale-version answer (§7.2) and the
 * missing-delivery answer. Scenario blocks cover S1–S8, S19, S23–S29 and the
 * composition attestation.
 */
import { describe, expect, test } from 'bun:test';
import type { ApplyDecision, Command, Decision, LivePr } from './commands';
import {
  attemptView,
  deliveryProof,
  headCoverage,
  reduce,
  stableIdempotencyKey,
  verifyCompositionAttestation,
} from './reducer';
import type { AttemptSnapshot, CompositionAttestation, ConstituentEvidence, DeliverySnapshot, KernelView, RoundSnapshot } from './types';

const REPO = 'acme/widgets';
const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: REPO, prNumber: 7, baseRef: 'dev',
  state: 'WORKING', stateReason: null, version: 5, currentHeadSha: 'H1', currentRound: 0, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const R = (o: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  id: 'r1', round: 1, headSha: 'H1', kind: 'full', status: 'queued', verdict: null, effectiveVerdict: null, failureCount: 0, ...o,
});
const A = (o: Partial<AttemptSnapshot> = {}): AttemptSnapshot => ({
  id: 'a1', family: 'review_fix', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: 'r1', taskId: 'ft1',
  status: 'queued', outcome: null, maxAttempts: 3, reportedShas: [], ...o,
});
const V = (d: DeliverySnapshot | null, rounds: RoundSnapshot[] = [], attempts: AttemptSnapshot[] = []): KernelView => ({ delivery: d, rounds, attempts });
const live = (headSha: string, o: Partial<LivePr> = {}): LivePr => ({ state: 'open', merged: false, headSha, headRepoFullName: REPO, baseRef: 'dev', ...o });

let seq = 0;
const newId = () => `id${++seq}`;
const run = (v: KernelView, cmd: Command): Decision => reduce(v, cmd, { newId });
function applied(dec: Decision): ApplyDecision {
  if (dec.result !== 'apply') throw new Error(`expected apply, got ${dec.result}: ${(dec as { reason?: string }).reason}`);
  return dec;
}
function expectResult(dec: Decision, result: Decision['result'], reason?: string) {
  expect({ result: dec.result, reason: (dec as { reason?: string }).reason }).toEqual(
    reason ? { result, reason } : { result, reason: (dec as { reason?: string }).reason },
  );
}
const effectKinds = (d: ApplyDecision) => d.effects.map((e) => e.kind);

// Rounds/attempts used across fixtures.
const decidedRC = R({ status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes' });
const att: CompositionAttestation = {
  repoFullName: REPO, prNumber: 7, baseSha: 'B0', aggregateHeadSha: 'H1', method: 'tree_equal', verifiedAt: '2026-10-06T00:00:00Z', verifier: 'kernel',
  constituents: [{ deliveryId: 'dx', roundId: 'rx', prNumber: 3, reviewedHeadSha: 'C1', equivalentHeadShas: [], mergedHeadSha: 'C1', landedSha: 'SQ1', landedPatchId: 'a'.repeat(64), reviewedPatchId: 'a'.repeat(64) }],
  novelDelta: { result: 'none' },
};
const attEv: ConstituentEvidence[] = [{ roundId: 'rx', deliveryId: 'dx', prNumber: 3, repoFullName: REPO, roundHeadSha: 'C1', roundStatus: 'decided', effectiveVerdict: 'approve', deliveryApprovedHeads: ['C1'] }];

/** One applied case per command (name, view, command, expected to-state). */
const APPLIED: Array<[string, KernelView, Command, string]> = [
  ['T2 PrBound', V(D({ prNumber: null, repoFullName: null, currentHeadSha: null })), { type: 'PrBound', actor: 'runner', repoFullName: REPO, prNumber: 7, live: live('H1') }, 'WORKING'],
  ['T3 HeadObserved', V(D()), { type: 'HeadObserved', actor: 'webhook', live: live('H2') }, 'WORKING'],
  ['T4 AttemptEnded', V(D()), { type: 'AttemptEnded', actor: 'runner', workerId: 'w9', taskId: 't1', outcome: 'success', localHeadSha: 'H1', commitCount: 1, live: live('H1') }, 'AWAITING_REVIEW'],
  ['T5 ReviewRequested', V(D({ state: 'AWAITING_REVIEW' })), { type: 'ReviewRequested', actor: 'kernel', headSha: 'H1', live: live('H1') }, 'AWAITING_REVIEW'],
  ['T6 ReviewVerdictRecorded', V(D({ state: 'AWAITING_REVIEW', currentRound: 1 }), [R()]), { type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: 'r1', verdict: 'approve', effectiveVerdict: 'approve', headBound: 'H1' }, 'APPROVED'],
  ['T7 ReviewBudgetExhausted', V(D({ state: 'CHANGES_REQUESTED', currentRound: 3 })), { type: 'ReviewBudgetExhausted', actor: 'kernel' }, 'ESCALATED'],
  ['T8 FixDispatched', V(D({ state: 'CHANGES_REQUESTED', currentRound: 1 }), [decidedRC]), { type: 'FixDispatched', actor: 'kernel', roundId: 'r1', taskId: 'ft1', maxAttempts: 3, revalidation: { live: live('H1'), newerApprove: false } }, 'CHANGES_REQUESTED'],
  ['T9 FixClaimed', V(D({ state: 'CHANGES_REQUESTED', currentRound: 1 }), [decidedRC], [A()]), { type: 'FixClaimed', actor: 'runner', attemptId: 'a1', revalidation: { live: live('H1'), approved: false } }, 'FIXING'],
  ['T10 CiFailedObserved', V(D({ state: 'AWAITING_REVIEW' })), { type: 'CiFailedObserved', actor: 'webhook', headSha: 'H1', signature: 'sig', maxAttempts: 3 }, 'REPAIRING'],
  ['T12 ConflictObserved', V(D({ state: 'APPROVED', approvedHeads: ['H1'] })), { type: 'ConflictObserved', actor: 'sweep:x', headSha: 'H1', mergeable: 'behind', maxAgentAttempts: 3 }, 'REPAIRING'],
  ['T14 HumanApproved', V(D({ state: 'ESCALATED', stateReason: 'review_escalated' })), { type: 'HumanApproved', actor: 'human:u', reviewId: 'gr1', commitId: 'H1', hasMergePermission: true }, 'APPROVED'],
  ['T15 LandingRequested', V(D({ state: 'APPROVED', approvedHeads: ['H1'], approvalBasis: 'verdict' })), { type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live('H1'), rails: { passed: true } }, 'LANDING'],
  ['T16 MergeCallResult', V(D({ state: 'LANDING', approvedHeads: ['H1'] })), { type: 'MergeCallResult', actor: 'kernel', headSha: 'H1', outcome: 'indeterminate' }, 'LANDING'],
  ['T17 PrMerged', V(D({ state: 'AWAITING_REVIEW' })), { type: 'PrMerged', actor: 'webhook', live: live('H1', { state: 'closed', merged: true, mergedAt: '2026-10-06T01:00:00Z', mergeCommitSha: 'M1' }) }, 'MERGED'],
  ['T18 PrClosedUnmerged', V(D({ state: 'AWAITING_REVIEW' })), { type: 'PrClosedUnmerged', actor: 'webhook', live: live('H1', { state: 'closed', updatedAt: 'u1' }), closeCause: 'manual' }, 'CLOSED_UNMERGED'],
  ['T19 PrReopened', V(D({ state: 'CLOSED_UNMERGED' })), { type: 'PrReopened', actor: 'webhook', live: live('H1', { updatedAt: 'u2' }) }, 'AWAITING_REVIEW'],
  ['T20 SupersessionRecorded', V(D({ state: 'CLOSED_UNMERGED' })), { type: 'SupersessionRecorded', actor: 'agent:t2', target: { repoFullName: REPO, prNumber: 9, merged: true, url: null }, reason: 'reopened fresh', authorised: true }, 'SUPERSEDED'],
  ['T21 Abandon', V(D({ state: 'CLOSED_UNMERGED' })), { type: 'Abandon', actor: 'human:u', reason: 'dropped' }, 'ABANDONED'],
  ['T22 PushRecoveryExhausted', V(D({ state: 'AWAITING_PUSH' })), { type: 'PushRecoveryExhausted', actor: 'kernel', localHeadSha: 'L2' }, 'ESCALATED'],
  ['T23 HumanResolve', V(D({ state: 'ESCALATED', stateReason: 'review_escalated' })), { type: 'HumanResolve', actor: 'human:u', choice: 'approve', expectedVersion: 5 }, 'APPROVED'],
  ['T24 DeliveryFailed', V(D({ prNumber: null, repoFullName: null })), { type: 'DeliveryFailed', actor: 'runner', reason: 'cancelled' }, 'FAILED'],
  ['T25 TrunkRedObserved', V(D({ state: 'AWAITING_REVIEW' })), { type: 'TrunkRedObserved', actor: 'kernel', incidentId: 'i1', signature: 'sig', headSha: 'H1', thresholdMet: true }, 'BLOCKED_ON_TRUNK'],
  ['T26 TrunkRecovered', V(D({ state: 'BLOCKED_ON_TRUNK', trunkIncidentId: 'i1', resumeState: 'APPROVED', approvedHeads: ['H1'] })), { type: 'TrunkRecovered', actor: 'kernel', incidentId: 'i1', baseStillRed: false, headPredatesFix: true }, 'APPROVED'],
  ['T27 ReviewRoundFailed', V(D({ state: 'AWAITING_REVIEW', currentRound: 1 }), [R()]), { type: 'ReviewRoundFailed', actor: 'reviewer', roundId: 'r1', reason: 'prose_verdict', maxContractRetries: 2 }, 'AWAITING_REVIEW'],
  ['CompositionAttested', V(D({ state: 'AWAITING_REVIEW' })), { type: 'CompositionAttested', actor: 'kernel', attestation: att, constituents: attEv }, 'APPROVED'],
  ['BudgetExtended', V(D({ state: 'ESCALATED', stateReason: 'ci_exhausted' }), [], [1, 2, 3].map((n) => A({ id: `c${n}`, family: 'ci', attemptNo: n, status: 'ended' }))), { type: 'BudgetExtended', actor: 'human:u', family: 'ci', headSha: 'H1', signature: 'sig', maxAttempts: 3, reason: 'one more try' }, 'REPAIRING'],
  ['MechanicalRepairFailed', V(D({ state: 'REPAIRING', stateReason: 'behind', boundAttemptId: 'm1' }), [], [A({ id: 'm1', family: 'conflict', mode: 'mechanical', taskId: null, triggerReason: 'behind' })]), { type: 'MechanicalRepairFailed', actor: 'effect:refresh_branch', attemptId: 'm1', reason: 'update-branch refused' }, 'ESCALATED'],
  ['RepairNotNeeded', V(D({ state: 'REPAIRING', stateReason: 'ci', boundAttemptId: 'c1', approvedHeads: ['H1'], approvalBasis: 'verdict' }), [], [A({ id: 'c1', family: 'ci', triggerReason: 'sig' })]), { type: 'RepairNotNeeded', actor: 'kernel', attemptId: 'c1', reason: 'ci_green' }, 'APPROVED'],
];

describe('generic: every applied transition is a version CAS (§7)', () => {
  test.each(APPLIED)('%s applies with the version and from-state it read', (_n, view, cmd, to) => {
    const dec = applied(run(view, cmd));
    expect(dec.toState).toBe(to as never);
    expect(dec.guard.version).toBe(view.delivery!.version);
    expect(dec.guard.states).toContain(view.delivery!.state);
    expect(dec.fromState).toBe(view.delivery!.state);
    expect(dec.idempotencyKey.length).toBeGreaterThan(0);
    expect(dec.command).toBe(cmd.type);
    // Every applied transition of a bound PR re-renders the activity comment for its new version.
    expect(dec.effects.some((e) => e.kind === 'render_activity' && e.dedupeKey === `render:d1:${view.delivery!.version + 1}`)).toBe(view.delivery!.prNumber != null || cmd.type === 'PrBound');
    // Effect dedupe keys are unique within the statement.
    expect(new Set(dec.effects.map((e) => e.dedupeKey)).size).toBe(dec.effects.length);
  });

  test.each(APPLIED)('%s with a stale expectedVersion is stale, carrying the current view', (_n, view, cmd) => {
    const dec = run(view, { ...cmd, expectedVersion: view.delivery!.version - 1 } as Command);
    expectResult(dec, 'stale', 'version_moved');
    expect((dec as { current: unknown }).current).toEqual({ state: view.delivery!.state, version: 5, head: view.delivery!.currentHeadSha, round: view.delivery!.currentRound });
  });

  test.each(APPLIED)('%s against no delivery is rejected', (_n, _view, cmd) => {
    expectResult(run(V(null), cmd), 'rejected', 'no_delivery');
  });

  test('a stable idempotency key is the applied key for every command that has one', () => {
    for (const [, view, cmd] of APPLIED) {
      const stable = stableIdempotencyKey(cmd, view.delivery);
      if (stable) expect(applied(run(view, cmd)).idempotencyKey).toBe(stable);
    }
  });

  test('commands naming a head or round carry the bound check in the guard (§7.3)', () => {
    const bound = new Set(['T5 ReviewRequested', 'T6 ReviewVerdictRecorded', 'T8 FixDispatched', 'T9 FixClaimed', 'T10 CiFailedObserved', 'T15 LandingRequested', 'T16 MergeCallResult']);
    for (const [name, view, cmd] of APPLIED) {
      if (!bound.has(name)) continue;
      const g = applied(run(view, cmd)).guard;
      expect(g.headSha).toBe(view.delivery!.currentHeadSha);
    }
    expect(applied(run(APPLIED[4][1], APPLIED[4][2])).guard.round).toBe(1);
  });
});

describe('T1 DeliveryOpened', () => {
  const cmd: Command = { type: 'DeliveryOpened', actor: 'runner', workspaceId: 'w1', ownerTaskId: 't1', requiresPr: true };
  test('creates a WORKING delivery at version 1 with no effects (no PR yet)', () => {
    const dec = applied(run(V(null), cmd));
    expect(dec.create).toEqual({ workspaceId: 'w1', ownerTaskId: 't1', maxRounds: 3 });
    expect(dec.toState).toBe('WORKING');
    expect(dec.guard).toEqual({ version: 0, states: [] });
    expect(dec.effects).toEqual([]);
    expect(dec.idempotencyKey).toBe('open:t1');
  });
  test('duplicate when the delivery exists; rejected for a non-PR task', () => {
    expectResult(run(V(D()), cmd), 'duplicate', 'delivery_exists');
    expectResult(run(V(null), { ...cmd, requiresPr: false } as Command), 'rejected', 'not_pr_deliverable');
  });
});

describe('T2 PrBound', () => {
  const base = V(D({ prNumber: null, repoFullName: null, currentHeadSha: null }));
  const cmd: Command = { type: 'PrBound', actor: 'runner', repoFullName: REPO, prNumber: 7, live: live('H1') };
  test('binds the PR columns without touching the head (only HeadObserved sets it)', () => {
    const dec = applied(run(base, cmd));
    expect(dec.patch).toEqual({ repoFullName: REPO, prNumber: 7, baseRef: 'dev' });
  });
  test('second bind: same PR duplicate, different PR rejected without resetting anything', () => {
    expectResult(run(V(D()), cmd), 'duplicate');
    expectResult(run(V(D()), { ...cmd, prNumber: 8 } as Command), 'rejected', 'pr_already_bound');
  });
  test('closed PR, fork PR and wrong state are rejected', () => {
    expectResult(run(base, { ...cmd, live: live('H1', { state: 'closed' }) } as Command), 'rejected', 'pr_not_open');
    expectResult(run(base, { ...cmd, live: live('H1', { headRepoFullName: 'evil/fork' }) } as Command), 'rejected', 'fork_pr');
    expectResult(run(V(D({ prNumber: null, repoFullName: null, state: 'APPROVED' })), cmd), 'rejected', 'state_not_allowed');
  });
  test('adoption creates AWAITING_REVIEW with round 1 at the live head', () => {
    const dec = applied(run(V(null), { ...cmd, adoption: { workspaceId: 'w1', ownerTaskId: 'syn1' } } as Command));
    expect(dec.create?.ownerTaskId).toBe('syn1');
    expect(dec.toState).toBe('AWAITING_REVIEW');
    expect(dec.patch).toMatchObject({ currentHeadSha: 'H1', currentRound: 1 });
    expect(dec.rounds).toEqual([expect.objectContaining({ op: 'insert', round: 1, headSha: 'H1', kind: 'full' })]);
    expect(effectKinds(dec)).toEqual(['dispatch_review', 'render_activity']);
  });
});

describe('T3 HeadObserved by state (§6.4)', () => {
  const h = (v: KernelView, head = 'H2', extra: Partial<Extract<Command, { type: 'HeadObserved' }>> = {}) =>
    run(v, { type: 'HeadObserved', actor: 'webhook', hintedHeadSha: 'PAYLOAD', live: live(head), ...extra });

  test('acts on the live head, not the payload head; same head is duplicate', () => {
    expect(applied(h(V(D()))).patch.currentHeadSha).toBe('H2');
    expectResult(h(V(D()), 'H1'), 'duplicate', 'head_unchanged');
  });
  test('a head that returns to an earlier SHA (A→B→A) is a new observation, not a replay (34b69829)', () => {
    // A (H1) → B (H2) → A (H1): the return to H1 must get its own key, or the
    // kernel answers it from the first H1 observation and keeps B as current.
    const first = applied(h(V(D({ currentHeadSha: 'H0', version: 3 })), 'H1'));
    const away = applied(h(V(D({ currentHeadSha: 'H1', version: 4 })), 'H2'));
    const back = applied(h(V(D({ currentHeadSha: 'H2', version: 5 })), 'H1'));
    expect(back.patch.currentHeadSha).toBe('H1');
    expect(new Set([first.idempotencyKey, away.idempotencyKey, back.idempotencyKey]).size).toBe(3);
    expect(back.idempotencyKey).toBe(stableIdempotencyKey({ type: 'HeadObserved', actor: 'k', live: live('H1') }, D({ currentHeadSha: 'H2', version: 5 })));
    // A cycle that repeats the same move (A→B again) is still new: the version is in the key.
    const awayAgain = applied(h(V(D({ currentHeadSha: 'H1', version: 6 })), 'H2'));
    expect(awayAgain.idempotencyKey).not.toBe(away.idempotencyKey);
  });
  test('terminal, unbound and closed are not applied', () => {
    expectResult(h(V(D({ state: 'MERGED' }))), 'stale', 'terminal');
    expectResult(h(V(D({ prNumber: null }))), 'rejected', 'pr_not_bound');
    expectResult(run(V(D()), { type: 'HeadObserved', actor: 'webhook', live: live('H2', { state: 'closed' }) }), 'rejected', 'pr_not_open');
  });
  test('AWAITING_REVIEW: round r superseded, delta round r+1 at H\'', () => {
    const dec = applied(h(V(D({ state: 'AWAITING_REVIEW', currentRound: 2 }), [R({ status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes' }), R({ id: 'r2', round: 2, status: 'reviewing', headSha: 'H1' })])));
    expect(dec.rounds).toEqual([
      { op: 'update', roundId: 'r2', whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } },
      expect.objectContaining({ op: 'insert', round: 3, headSha: 'H2', kind: 'delta', priorRound: 1 }),
    ]);
    expect(dec.patch).toMatchObject({ currentRound: 3, currentHeadSha: 'H2' });
  });
  test('CHANGES_REQUESTED: unclaimed fix cancelled, next round', () => {
    const dec = applied(h(V(D({ state: 'CHANGES_REQUESTED', currentRound: 1 }), [decidedRC], [A()])));
    expect(dec.toState).toBe('AWAITING_REVIEW');
    expect(dec.attempts).toContainEqual({ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' });
    expect(effectKinds(dec)).toContain('cancel_open_attempts');
  });
  test('FIXING: mid-fix push recorded as provenance, state unchanged', () => {
    const dec = applied(h(V(D({ state: 'FIXING', currentRound: 1, boundAttemptId: 'a1' }), [decidedRC], [A({ status: 'running' })])));
    expect(dec.toState).toBe('FIXING');
    expect(dec.attempts).toEqual([{ op: 'update', attemptId: 'a1', whenStatus: ['queued', 'running'], set: { appendReportedSha: 'H2' } }]);
    expect(dec.rounds).toEqual([]);
  });
  test('APPROVED (S2): non-equivalent push starts a delta round on the push', () => {
    const dec = applied(h(V(D({ state: 'APPROVED', approvedHeads: ['H1'], approvalBasis: 'verdict', currentRound: 1 }), [R({ status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' })])));
    expect(dec.toState).toBe('AWAITING_REVIEW');
    expect(dec.rounds).toContainEqual(expect.objectContaining({ op: 'insert', round: 2, kind: 'delta', headSha: 'H2' }));
    expect(effectKinds(dec)).toContain('dispatch_review');
  });
  test('APPROVED (S3): carry-forward appends once to approved_heads', () => {
    const dec = applied(h(V(D({ state: 'APPROVED', approvedHeads: ['H1'], approvalBasis: 'verdict' })), 'H2', { carryForward: 'own_refresh' }));
    expect(dec.toState).toBe('APPROVED');
    expect(dec.patch.approvedHeads).toEqual(['H1', 'H2']);
    expect(dec.idempotencyKey).toBe(`head:${REPO}#7:H1->H2@v5`);
  });
  test('LANDING: aborts landing to a new round when not equivalent', () => {
    expect(applied(h(V(D({ state: 'LANDING', approvedHeads: ['H1'] })))).toState).toBe('AWAITING_REVIEW');
  });
  test('ESCALATED: review_* escalations re-review, others only record', () => {
    expect(applied(h(V(D({ state: 'ESCALATED', stateReason: 'review_exhausted' })))).toState).toBe('AWAITING_REVIEW');
    const rec = applied(h(V(D({ state: 'ESCALATED', stateReason: 'landing_needs_human' }))));
    expect(rec.toState).toBe('ESCALATED');
    expect(rec.rounds).toEqual([]);
  });
  test('BLOCKED_ON_TRUNK / CLOSED_UNMERGED record the head only', () => {
    expect(applied(h(V(D({ state: 'BLOCKED_ON_TRUNK' })))).toState).toBe('BLOCKED_ON_TRUNK');
    expect(applied(h(V(D({ state: 'CLOSED_UNMERGED' })))).toState).toBe('CLOSED_UNMERGED');
  });
  test('AWAITING_PUSH: proof holds → round; proof fails → stays and records', () => {
    const v = V(D({ state: 'AWAITING_PUSH', currentRound: 1, boundAttemptId: 'a1' }), [decidedRC], [A({ status: 'ended', outcome: 'unproven', reportedShas: ['L2'] })]);
    const ok = applied(h(v, 'L2'));
    expect(ok.toState).toBe('AWAITING_REVIEW');
    expect(ok.attempts).toEqual([{ op: 'update', attemptId: 'a1', whenStatus: ['queued', 'running', 'ended'], set: { outcome: 'delivered', pushedHeadSha: 'L2' } }]);
    const foreign = applied(h(v, 'X9'));
    expect(foreign.toState).toBe('AWAITING_PUSH');
    expect(foreign.evidence.proof).toEqual({ holds: false, reason: 'live_head_missing_local' });
    expect(applied(h(v, 'X9', { proof: { liveContainsLocal: true } })).toState).toBe('AWAITING_REVIEW');
    // A head that fails the proof re-arms push_recovery from that head.
    expect(foreign.effects.find((e) => e.kind === 'push_recovery')?.dedupeKey).toBe(`push_recovery:d1:L2:head:X9`);
  });
  test('AWAITING_PUSH (owner, no ledger row): L is the pending local head; proof holds → round 1 at the pushed head', () => {
    const v = V(D({ state: 'AWAITING_PUSH', currentRound: 0, currentHeadSha: 'H1', boundAttemptId: null, pushPendingLocalHead: 'L5' }));
    const ok = applied(h(v, 'L5'));
    expect(ok.toState).toBe('AWAITING_REVIEW');
    expect(ok.patch).toMatchObject({ currentHeadSha: 'L5', currentRound: 1 });
    expect(effectKinds(ok)).toContain('dispatch_review');
    const other = applied(h(v, 'H7'));
    expect(other.toState).toBe('AWAITING_PUSH');
    expect(other.evidence.proof).toEqual({ holds: false, reason: 'live_head_missing_local' });
    // Unknown L (reaped before reporting): moved off Hb plus a changed content diff.
    const unknown = V(D({ state: 'AWAITING_PUSH', currentHeadSha: 'H1', pushPendingLocalHead: null }));
    expect(applied(h(unknown, 'H2')).toState).toBe('AWAITING_PUSH');
    expect(applied(h(unknown, 'H2', { proof: { liveContainsLocal: false, contentDiffChanged: true } })).toState).toBe('AWAITING_REVIEW');
  });
  test('REPAIRING: proof → new round, or APPROVED by carry-forward (T11/T13); no proof records only', () => {
    const v = V(D({ state: 'REPAIRING', stateReason: 'behind', approvedHeads: ['H1'], approvalBasis: 'verdict', boundAttemptId: 'm1' }), [], [A({ id: 'm1', family: 'conflict', mode: 'mechanical', status: 'running', triggerReason: 'behind' })]);
    const cf = applied(h(v, 'H2', { carryForward: 'own_refresh', proof: { liveContainsLocal: false, contentDiffChanged: true } }));
    expect(cf.toState).toBe('APPROVED');
    expect(cf.patch.approvedHeads).toEqual(['H1', 'H2']);
    expect(cf.attempts[0]).toMatchObject({ attemptId: 'm1', set: { outcome: 'delivered', pushedHeadSha: 'H2' } });
    // The platform's own refresh_branch is an own refresh even when the caller did not say so (T13).
    expect(applied(h(v, 'H2', { proof: { liveContainsLocal: false, contentDiffChanged: true } })).toState).toBe('APPROVED');
    // A known non-descendant while the attempt runs is a foreign push: recorded, the attempt still decides.
    const foreign = applied(h(v, 'H2', { attribution: { descendsFromBound: false } }));
    expect(foreign.toState).toBe('REPAIRING');
    expect(foreign.evidence.foreignPush).toBe(true);
  });
});

describe('T4 AttemptEnded by outcome (§6.5)', () => {
  const end = (v: KernelView, o: Partial<Extract<Command, { type: 'AttemptEnded' }>>): Decision =>
    run(v, { type: 'AttemptEnded', actor: 'runner', workerId: 'w9', taskId: 't1', outcome: 'success', localHeadSha: 'H1', commitCount: 1, live: live('H1'), ...o });

  test('WORKING success with the head on GitHub → AWAITING_REVIEW, round 1 (§15 step 2)', () => {
    const dec = applied(end(V(D()), {}));
    expect(dec.toState).toBe('AWAITING_REVIEW');
    expect(dec.rounds).toEqual([expect.objectContaining({ op: 'insert', round: 1, headSha: 'H1', kind: 'full' })]);
    expect(dec.idempotencyKey).toBe('end:w9');
  });
  test('WORKING success: an open round already at the head is reused', () => {
    const dec = applied(end(V(D(), [R()]), {}));
    expect(dec.toState).toBe('AWAITING_REVIEW');
    expect(dec.rounds).toEqual([]);
  });
  test('policy needs no review → APPROVED by policy: no round, no verdict, approved_heads untouched', () => {
    const dec = applied(end(V(D()), { reviewRequired: false }));
    expect(dec.toState).toBe('APPROVED');
    expect(dec.patch).toMatchObject({ approvalBasis: 'policy', stateReason: 'policy_no_review', currentHeadSha: 'H1' });
    expect(dec.patch.approvedHeads).toBeUndefined();
    expect(dec.rounds).toEqual([]);
    expect(dec.effects.some((e) => e.kind === 'post_review' || e.kind === 'dispatch_review')).toBe(false);
    // Policy covers the current head for landing, and is never reported as a verdict.
    const after = D({ state: 'APPROVED', approvalBasis: 'policy', currentHeadSha: 'H1' });
    expect(headCoverage(after, 'H1')).toBe('policy');
    expect(headCoverage(after, 'H0')).toBe('none');
    // Landing is still gated by the rails.
    expectResult(run(V(after), { type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live('H1'), rails: { passed: false, redCi: true } }), 'rejected', 'rail_not_overridable');
    expect(applied(run(V(after), { type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live('H1'), rails: { passed: true } })).evidence.coverage).toBe('policy');
  });
  test('a push under a policy approval stays APPROVED by policy at the new head', () => {
    const dec = applied(run(V(D({ state: 'APPROVED', approvalBasis: 'policy', stateReason: 'policy_no_review' })), { type: 'HeadObserved', actor: 'webhook', live: live('H2') }));
    expect(dec.toState).toBe('APPROVED');
    expect(dec.patch).toMatchObject({ currentHeadSha: 'H2' });
    expect(dec.patch.approvedHeads).toBeUndefined();
    expect(dec.rounds).toEqual([]);
  });
  test('policy approval survives landing aborts and repairs without ever creating a round', () => {
    const pol = { approvalBasis: 'policy' as const, stateReason: 'policy_no_review' };
    const land = applied(run(V(D({ state: 'LANDING', ...pol })), { type: 'HeadObserved', actor: 'webhook', live: live('H2') }));
    expect(land.toState).toBe('APPROVED');
    expect(land.rounds).toEqual([]);
    const rep = V(D({ state: 'REPAIRING', ...pol, stateReason: 'behind', boundAttemptId: 'm1' }), [], [A({ id: 'm1', family: 'conflict', mode: 'mechanical', status: 'running' })]);
    const viaHead = applied(run(rep, { type: 'HeadObserved', actor: 'webhook', live: live('H2'), proof: { liveContainsLocal: false, contentDiffChanged: true } }));
    expect(viaHead.toState).toBe('APPROVED');
    expect(viaHead.patch.approvedHeads).toBeUndefined();
    const viaEnd = applied(run(rep, { type: 'AttemptEnded', actor: 'runner', workerId: 'w', attemptId: 'm1', outcome: 'success', localHeadSha: 'H2', commitCount: 1, live: live('H2') }));
    expect(viaEnd.toState).toBe('APPROVED');
    expect(viaEnd.rounds).toEqual([]);
    expect(viaEnd.patch.approvedHeads).toBeUndefined();
  });
  test('head already decided → the state its verdict maps to, as T6 does', () => {
    const appr = applied(end(V(D({ currentRound: 1 }), [R({ status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' })]), {}));
    expect(appr.toState).toBe('APPROVED');
    expect(appr.patch).toMatchObject({ approvedHeads: ['H1'], approvalBasis: 'verdict' });
    const rc = applied(end(V(D({ currentRound: 1 }), [decidedRC]), {}));
    expect(rc.toState).toBe('CHANGES_REQUESTED');
    expect(rc.effects.find((e) => e.kind === 'dispatch_fix')).toMatchObject({ payload: { roundId: 'r1', attemptNo: 1 } });
    const rcOpenFix = applied(end(V(D({ currentRound: 1 }), [decidedRC], [A()]), {}));
    expect(rcOpenFix.toState).toBe('CHANGES_REQUESTED');
    expect(rcOpenFix.effects.some((e) => e.kind === 'dispatch_fix')).toBe(false);
    const rcExhausted = applied(end(V(D({ currentRound: 3 }), [R({ round: 3, status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes' })]), {}));
    expect(rcExhausted.patch.stateReason).toBe('review_exhausted');
    const esc = applied(end(V(D({ currentRound: 1 }), [R({ status: 'decided', verdict: 'escalate', effectiveVerdict: 'escalate' })]), {}));
    expect(esc.toState).toBe('ESCALATED');
    expect(esc.patch.stateReason).toBe('review_escalated');
  });
  test('WORKING success with commits not on GitHub, or no PR → AWAITING_PUSH + push_recovery', () => {
    const dec = applied(end(V(D()), { localHeadSha: 'L9' }));
    expect(dec.toState).toBe('AWAITING_PUSH');
    expect(dec.effects.find((e) => e.kind === 'push_recovery')).toMatchObject({ payload: { localHeadSha: 'L9', try: 1 }, delayMs: 120_000 });
    expect(applied(end(V(D({ prNumber: null, repoFullName: null })), { live: null })).toState).toBe('AWAITING_PUSH');
  });
  test('WORKING failed: retry budget left → WORKING; spent → FAILED (no PR) / ESCALATED (unpushed) / review', () => {
    expect(applied(end(V(D()), { outcome: 'failed', taskRetryBudgetLeft: true })).toState).toBe('WORKING');
    expect(applied(end(V(D({ prNumber: null, repoFullName: null })), { outcome: 'lost', live: null })).toState).toBe('FAILED');
    // Local commits not on GitHub: push recovery first (AC-10); T22 reaches a person after its tries.
    const unpushed = applied(end(V(D()), { outcome: 'failed', localHeadSha: 'L9' }));
    expect(unpushed.toState).toBe('AWAITING_PUSH');
    expect(effectKinds(unpushed)).toContain('push_recovery');
    expect(applied(end(V(D()), { outcome: 'failed', commitCount: 0, localHeadSha: null })).toState).toBe('AWAITING_REVIEW');
    // Budget spent, PR bound, nothing reviewable: a person owns it, never a silent WORKING.
    const closed = applied(end(V(D(), [R()]), { outcome: 'failed', commitCount: 0, localHeadSha: null, live: live('H1', { state: 'closed' }) }));
    expect(closed.toState).toBe('ESCALATED');
    expect(closed.patch.stateReason).toBe('push_undeliverable');
    expect(applied(end(V(D(), [R()]), { outcome: 'failed', commitCount: 0, localHeadSha: null })).toState).toBe('AWAITING_REVIEW');
    expect(applied(end(V(D(), [decidedRC]), { outcome: 'lost', commitCount: 0, localHeadSha: null })).toState).toBe('CHANGES_REQUESTED');
  });
  test('WORKING unproven: commits → AWAITING_PUSH; nothing → requeue', () => {
    expect(applied(end(V(D({ prNumber: null, repoFullName: null })), { outcome: 'unproven', live: null })).toState).toBe('AWAITING_PUSH');
    expect(applied(end(V(D({ prNumber: null, repoFullName: null })), { outcome: 'unproven', commitCount: 0, live: null, taskRetryBudgetLeft: true })).toState).toBe('WORKING');
  });
  test('S30: WORKING unproven with nothing local and the task retry queued is a requeue even with the PR open (no round at the old head)', () => {
    const dec = applied(end(V(D()), { outcome: 'unproven', commitCount: 0, localHeadSha: null, taskRetryBudgetLeft: true }));
    expect(dec.toState).toBe('WORKING');
    expect(dec.evidence).toMatchObject({ requeue: true });
    expect(effectKinds(dec)).not.toContain('dispatch_review');
    // Retry spent: nothing local to lose, so the open PR's head hands on exactly as row 1.
    expect(applied(end(V(D()), { outcome: 'unproven', commitCount: 0, localHeadSha: null })).toState).toBe('AWAITING_REVIEW');
    // Commits exist: AWAITING_PUSH whatever the retry budget says.
    expect(applied(end(V(D()), { outcome: 'unproven', commitCount: 2, localHeadSha: 'L9', taskRetryBudgetLeft: true })).toState).toBe('AWAITING_PUSH');
  });
  test('an exit for a non-bound attempt is stale', () => {
    expectResult(end(V(D()), { taskId: 'other' }), 'stale', 'attempt_not_bound');
    expectResult(end(V(D({ state: 'APPROVED' })), {}), 'stale', 'attempt_not_bound');
    expectResult(end(V(D({ state: 'FIXING', boundAttemptId: 'a1' }), [], [A({ status: 'running' })]), { attemptId: 'zz' }), 'stale', 'attempt_not_bound');
  });

  const fixing = (o: Partial<AttemptSnapshot> = {}) => V(D({ state: 'FIXING', currentRound: 1, boundAttemptId: 'a1' }), [decidedRC], [A({ status: 'running', ...o })]);
  test('S1 / AC-1: fix ends with a local commit, GitHub head unchanged → AWAITING_PUSH, no round', () => {
    const dec = applied(end(fixing(), { attemptId: 'a1', localHeadSha: 'L2', live: live('H1') }));
    expect(dec.toState).toBe('AWAITING_PUSH');
    expect(dec.rounds).toEqual([]);
    expect(effectKinds(dec)).toContain('push_recovery');
    expect(dec.attempts[0]).toMatchObject({ attemptId: 'a1', set: { status: 'ended', outcome: 'unproven', appendReportedSha: 'L2' } });
    expect(dec.evidence.proof).toEqual({ holds: false, reason: 'head_not_advanced' });
  });
  test('fix ends with proof → AWAITING_REVIEW, delta round 2 bound to the pushed head', () => {
    const dec = applied(end(fixing(), { attemptId: 'a1', localHeadSha: 'L2', live: live('L2') }));
    expect(dec.toState).toBe('AWAITING_REVIEW');
    expect(dec.rounds).toContainEqual(expect.objectContaining({ op: 'insert', round: 2, headSha: 'L2', kind: 'delta' }));
    expect(dec.patch).toMatchObject({ currentHeadSha: 'L2', boundAttemptId: null });
    expect(dec.attempts[0]).toMatchObject({ set: { outcome: 'delivered', pushedHeadSha: 'L2' } });
  });
  test('S19: fix worker killed → CHANGES_REQUESTED with the next attempt dispatched, or exhausted', () => {
    const dec = applied(end(fixing(), { attemptId: 'a1', outcome: 'lost' }));
    expect(dec.toState).toBe('CHANGES_REQUESTED');
    expect(dec.effects.find((e) => e.kind === 'dispatch_fix')).toMatchObject({ payload: { attemptNo: 2 } });
    expect(dec.attempts[0]).toMatchObject({ set: { status: 'ended', outcome: 'failed' } });
    const ex = applied(end(fixing({ attemptNo: 3 }), { attemptId: 'a1', outcome: 'failed' }));
    expect(ex.toState).toBe('ESCALATED');
    expect(ex.patch.stateReason).toBe('review_exhausted');
  });
  const repairing = (o: Partial<AttemptSnapshot> = {}, d: Partial<DeliverySnapshot> = {}) =>
    V(D({ state: 'REPAIRING', stateReason: 'ci', boundAttemptId: 'c1', ...d }), [], [A({ id: 'c1', family: 'ci', triggerReason: 'sig', status: 'running', ...o })]);
  test('REPAIRING: CI fix delivered → round; carry-forward → APPROVED; failed → next ledger row; exhausted', () => {
    expect(applied(end(repairing(), { attemptId: 'c1', localHeadSha: 'H2', live: live('H2') })).toState).toBe('AWAITING_REVIEW');
    const cf = applied(end(repairing({}, { approvedHeads: ['H1'], approvalBasis: 'composition', compositionHeads: ['H1'] }), { attemptId: 'c1', localHeadSha: 'H2', live: live('H2'), carryForward: 'content_equivalent' }));
    expect(cf.toState).toBe('APPROVED');
    const retry = applied(end(repairing(), { attemptId: 'c1', outcome: 'failed' }));
    expect(retry.toState).toBe('REPAIRING');
    expect(retry.attempts[1]).toMatchObject({ op: 'insert', family: 'ci', attemptNo: 2, status: 'queued' });
    expect(retry.patch.boundAttemptId).toBe((retry.attempts[1] as { id: string }).id);
    expect(effectKinds(retry)).toContain('dispatch_ci_fix');
    const mech = applied(end(repairing({ family: 'conflict', mode: 'mechanical' }), { attemptId: 'c1', outcome: 'failed' }));
    expect(effectKinds(mech)).toContain('refresh_branch');
    const migr = applied(end(repairing({ family: 'migration', mode: 'mechanical' }), { attemptId: 'c1', outcome: 'failed' }));
    expect(effectKinds(migr)).toContain('renumber_migration');
    const agentConflict = applied(end(repairing({ family: 'conflict' }), { attemptId: 'c1', outcome: 'failed' }));
    expect(effectKinds(agentConflict)).toContain('dispatch_conflict_fix');
    // The ledger counts dispatched rows (allocation is consumption), not the attempt number.
    const spentView = (family: 'ci' | 'conflict') => {
      const v = repairing({ attemptNo: 3, family });
      return { ...v, attempts: [A({ id: 'p1', family, attemptNo: 1, status: 'ended' }), A({ id: 'p2', family, attemptNo: 2, status: 'ended' }), ...v.attempts] };
    };
    expect(applied(end(spentView('ci'), { attemptId: 'c1', outcome: 'failed' })).patch.stateReason).toBe('ci_exhausted');
    expect(applied(end(spentView('conflict'), { attemptId: 'c1', outcome: 'failed' })).patch.stateReason).toBe('conflict_exhausted');
    // A skipped row (revalidation found nothing to do) spends nothing: attempt 3 after a skip is not the last.
    const skipped = repairing({ attemptNo: 3 });
    const withSkip = { ...skipped, attempts: [A({ id: 'p1', family: 'ci', attemptNo: 1, status: 'ended' }), A({ id: 'p2', family: 'ci', attemptNo: 2, status: 'skipped' }), ...skipped.attempts] };
    expect(applied(end(withSkip, { attemptId: 'c1', outcome: 'failed' })).toState).toBe('REPAIRING');
  });
});

describe('invariant: an ended owner attempt with no retry queued never leaves the delivery in WORKING (§4 one owner)', () => {
  const outcomes = ['success', 'failed', 'lost', 'unproven'] as const;
  const lives: Array<[string, LivePr | null]> = [['open-H1', live('H1')], ['open-H2', live('H2')], ['closed', live('H1', { state: 'closed' })], ['merged', live('H1', { state: 'closed', merged: true })], ['none', null]];
  const roundSets: Array<[string, RoundSnapshot[]]> = [
    ['no round', []],
    ['open round', [R()]],
    ['decided approve', [R({ status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' })]],
    ['decided request_changes', [decidedRC]],
    ['decided escalate', [R({ status: 'decided', verdict: 'escalate', effectiveVerdict: 'escalate' })]],
  ];
  const cases: Array<[string, KernelView, Command]> = [];
  for (const outcome of outcomes) for (const [ln, l] of lives) for (const [rn, rounds] of roundSets)
    for (const prBound of [true, false]) for (const commitCount of [0, 1]) for (const localHeadSha of [null, 'H1', 'L9'])
      for (const reviewRequired of [true, false]) {
        const d = prBound ? D({ currentRound: rounds.length ? 1 : 0 }) : D({ prNumber: null, repoFullName: null, currentHeadSha: null });
        cases.push([`${outcome} live=${ln} ${rn} pr=${prBound} commits=${commitCount} L=${localHeadSha} review=${reviewRequired}`, V(d, prBound ? rounds : []),
          { type: 'AttemptEnded', actor: 'runner', workerId: 'w', taskId: 't1', outcome, localHeadSha, commitCount, live: prBound ? l : null, reviewRequired, taskRetryBudgetLeft: false }]);
      }
  test(`covers ${cases.length} combinations`, () => {
    const stuck = cases.filter(([, v, c]) => { const dec = run(v, c); return dec.result === 'apply' && dec.toState === 'WORKING'; }).map(([n]) => n);
    expect(stuck).toEqual([]);
  });
  test('the only WORKING outcome is a requeue the task still has budget for', () => {
    const dec = applied(run(V(D()), { type: 'AttemptEnded', actor: 'runner', workerId: 'w', taskId: 't1', outcome: 'failed', localHeadSha: null, commitCount: 0, live: live('H1'), taskRetryBudgetLeft: true }));
    expect(dec.toState).toBe('WORKING');
    expect(dec.evidence.requeue).toBe(true);
  });
});

describe('T5 ReviewRequested (AC-2)', () => {
  const rq = (v: KernelView, o: Partial<Extract<Command, { type: 'ReviewRequested' }>> = {}) =>
    run(v, { type: 'ReviewRequested', actor: 'kernel', headSha: 'H1', live: live('H1'), ...o });
  test('rejects a decided head unless a human forces it; force is recorded in bypass', () => {
    const v = V(D({ state: 'AWAITING_REVIEW', currentRound: 1 }), [decidedRC]);
    expectResult(rq(v), 'rejected', 'head_already_reviewed');
    expectResult(rq(v, { forced: true }), 'rejected', 'force_requires_human');
    const forced = applied(rq(v, { forced: true, actor: 'human:u' }));
    expect(forced.bypass).toEqual({ forced: true, actor: 'human:u' });
    expect(forced.idempotencyKey).toBe('round:d1:H1:2');
  });
  test('rejects head ≠ current, an in-flight round, an unbound PR and AWAITING_PUSH (§15 step 6)', () => {
    expectResult(rq(V(D({ state: 'AWAITING_REVIEW' })), { headSha: 'H0' }), 'rejected', 'round_head_not_current');
    expectResult(rq(V(D({ state: 'AWAITING_REVIEW' })), { live: live('H2') }), 'rejected', 'round_head_not_current');
    expectResult(rq(V(D({ state: 'AWAITING_REVIEW', currentRound: 1 }), [R()])), 'rejected', 'review_in_flight');
    expectResult(rq(V(D({ prNumber: null }))), 'rejected', 'pr_not_bound');
    expectResult(rq(V(D({ state: 'AWAITING_PUSH' }))), 'rejected', 'state_not_allowed');
  });
  test('from CHANGES_REQUESTED cancels the open fix', () => {
    const dec = applied(rq(V(D({ state: 'CHANGES_REQUESTED', currentRound: 1 }), [decidedRC]), { forced: true, actor: 'human:u' }));
    expect(dec.attempts).toEqual([{ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' }]);
  });
});

describe('T6 ReviewVerdictRecorded (§8, AC-5)', () => {
  const v = (d: Partial<DeliverySnapshot> = {}, r: Partial<RoundSnapshot> = {}) => V(D({ state: 'AWAITING_REVIEW', currentRound: 1, ...d }), [R(r)]);
  const verdict = (view: KernelView, o: Partial<Extract<Command, { type: 'ReviewVerdictRecorded' }>> = {}) =>
    run(view, { type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: 'r1', verdict: 'request_changes', effectiveVerdict: 'request_changes', headBound: 'H1', ...o });

  test('approve: APPROVED bound to the exact head, GitHub review at that commit, open fixes cancelled', () => {
    const dec = applied(verdict(v(), { verdict: 'approve', effectiveVerdict: 'approve' }));
    expect(dec.patch).toMatchObject({ approvedHeads: ['H1'], approvalBasis: 'verdict' });
    expect(dec.effects.find((e) => e.kind === 'post_review')?.payload).toEqual({ commitId: 'H1', event: 'APPROVE', roundId: 'r1' });
    expect(dec.attempts).toEqual([{ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' }]);
    expect(dec.rounds[0]).toMatchObject({ op: 'update', roundId: 'r1', set: { status: 'decided', verdict: 'approve' } });
  });
  test('request_changes under budget: CHANGES_REQUESTED + dispatch_fix; at budget: ESCALATED(review_exhausted) (S8)', () => {
    const dec = applied(verdict(v()));
    expect(dec.toState).toBe('CHANGES_REQUESTED');
    expect(effectKinds(dec)).toEqual(['post_review', 'dispatch_fix', 'render_activity']);
    const ex = applied(verdict(v({ currentRound: 3 }, { round: 3 })));
    expect(ex.toState).toBe('ESCALATED');
    expect(ex.patch.stateReason).toBe('review_exhausted');
    expect(effectKinds(ex)).toContain('escalate_exhaustion');
  });
  test('escalate and server-overridden approve → ESCALATED(review_escalated)', () => {
    expect(applied(verdict(v(), { verdict: 'escalate', effectiveVerdict: 'escalate' })).patch.stateReason).toBe('review_escalated');
    const over = applied(verdict(v(), { verdict: 'approve', effectiveVerdict: 'escalate' }));
    expect(over.toState).toBe('ESCALATED');
    expect(over.patch.approvedHeads).toBeUndefined();
  });
  test('S4: a verdict for a superseded head is stored on its round, state unchanged, nothing posted', () => {
    const dec = verdict(V(D({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: 'H2' }), [R(), R({ id: 'r2', round: 2, headSha: 'H2' })]), { verdict: 'approve', effectiveVerdict: 'approve' });
    expectResult(dec, 'stale', 'round_superseded');
    expect((dec as { record: { rounds: unknown[] } }).record.rounds).toEqual([
      { op: 'update', roundId: 'r1', whenStatus: ['queued', 'reviewing'], set: { status: 'superseded', verdict: 'approve', effectiveVerdict: 'approve', confidence: null, decided: true } },
    ]);
    const already = verdict(V(D({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: 'H2' }), [R({ status: 'superseded' })]), { verdict: 'approve', effectiveVerdict: 'approve' });
    expectResult(already, 'stale', 'round_superseded');
    expect((already as { record: { rounds: Array<{ whenStatus: string[] }> } }).record.rounds[0].whenStatus).toEqual(['superseded']);
  });
  test('a verdict arriving after the delivery moved on is stale; S5 replay is duplicate', () => {
    expectResult(verdict(v({ state: 'APPROVED' })), 'stale', 'round_superseded');
    expectResult(verdict(v({}, { status: 'decided', verdict: 'request_changes' })), 'duplicate', 'verdict_already_recorded');
    expectResult(verdict(v({}, { status: 'decided', verdict: 'approve' })), 'stale', 'round_closed');
    expectResult(verdict(v({}, { status: 'failed' })), 'stale', 'round_closed');
    expectResult(verdict(v({}, { status: 'superseded', verdict: 'approve' })), 'stale', 'round_closed');
  });
  test('a verdict naming a different head than its round, or an unknown round, is rejected', () => {
    expectResult(verdict(v(), { headBound: 'H0' }), 'rejected', 'verdict_head_mismatch');
    expectResult(verdict(v(), { roundId: 'nope' }), 'rejected', 'unknown_round');
  });
});

describe('T7 ReviewBudgetExhausted', () => {
  test('only at budget, only from CHANGES_REQUESTED / FIXING', () => {
    expectResult(run(V(D({ state: 'CHANGES_REQUESTED', currentRound: 1 })), { type: 'ReviewBudgetExhausted', actor: 'kernel' }), 'rejected', 'budget_not_exhausted');
    expectResult(run(V(D({ state: 'APPROVED', currentRound: 3 })), { type: 'ReviewBudgetExhausted', actor: 'kernel' }), 'stale', 'state_moved');
    expect(applied(run(V(D({ state: 'FIXING', currentRound: 3 })), { type: 'ReviewBudgetExhausted', actor: 'kernel' })).idempotencyKey).toBe('exhaust:d1:H1');
  });
});

describe('T8 FixDispatched / T9 FixClaimed (S7, S25, §10.5)', () => {
  const cr = (attempts: AttemptSnapshot[] = [], d: Partial<DeliverySnapshot> = {}) => V(D({ state: 'CHANGES_REQUESTED', currentRound: 1, ...d }), [decidedRC], attempts);
  const dispatch = (v: KernelView, o: Partial<Extract<Command, { type: 'FixDispatched' }>> = {}) =>
    run(v, { type: 'FixDispatched', actor: 'kernel', roundId: 'r1', taskId: 'ft1', maxAttempts: 3, revalidation: { live: live('H1'), newerApprove: false }, ...o });

  test('allocation is consumption: the ledger row is inserted by the dispatching statement', () => {
    const dec = applied(dispatch(cr()));
    expect(dec.attempts).toEqual([expect.objectContaining({ op: 'insert', family: 'review_fix', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: 'r1', taskId: 'ft1', status: 'queued', maxAttempts: 3 })]);
    expect(dec.idempotencyKey).toBe('fix:d1:r1:1');
    expect(dec.guard).toMatchObject({ headSha: 'H1', round: 1 });
    expect(applied(dispatch(cr([A({ status: 'ended', outcome: 'failed' })]))).attempts[0]).toMatchObject({ attemptNo: 2 });
  });
  test('S7: a second dispatch for the same round while one is in flight is duplicate', () => {
    expectResult(dispatch(cr([A()])), 'duplicate', 'fix_in_flight');
  });
  test('budget exhausted, superseded round and revalidation failures allocate nothing', () => {
    expectResult(dispatch(cr([A({ attemptNo: 3, status: 'ended' })])), 'rejected', 'budget_exhausted');
    expectResult(dispatch(cr([], { currentRound: 2 })), 'rejected', 'newer_verdict_supersedes_fix');
    expectResult(dispatch(cr(), { revalidation: { live: live('H1', { state: 'closed', merged: true }), newerApprove: false } }), 'rejected', 'fix_not_needed');
    expectResult(dispatch(cr(), { revalidation: { live: live('H2'), newerApprove: false } }), 'rejected', 'fix_not_needed');
    expectResult(dispatch(cr(), { revalidation: { live: live('H1'), newerApprove: true } }), 'rejected', 'fix_not_needed');
    expectResult(dispatch(V(D({ state: 'APPROVED' }))), 'stale', 'state_moved');
  });

  const claim = (v: KernelView, o: Partial<Extract<Command, { type: 'FixClaimed' }>> = {}) =>
    run(v, { type: 'FixClaimed', actor: 'runner', attemptId: 'a1', revalidation: { live: live('H1'), approved: false }, ...o });
  test('claim binds (H, r, a) and starts the attempt', () => {
    const dec = applied(claim(cr([A()])));
    expect(dec.patch).toEqual({ boundAttemptId: 'a1' });
    expect(dec.attempts).toEqual([{ op: 'update', attemptId: 'a1', whenStatus: ['queued'], set: { status: 'running' } }]);
  });
  test('claim of a superseded or no-longer-needed fix is rejected and the ledger row skipped (not failed)', () => {
    const sup = claim(cr([A({ triggerReason: 'r0' })]));
    expectResult(sup, 'rejected', 'fix_superseded');
    expect((sup as { record: { attempts: unknown[] } }).record.attempts).toEqual([{ op: 'update', attemptId: 'a1', whenStatus: ['queued'], set: { status: 'skipped', outcome: 'noop', ended: true } }]);
    expectResult(claim(cr([A()]), { revalidation: { live: live('H1'), approved: true } }), 'rejected', 'fix_not_needed');
    expectResult(claim(cr([A()]), { revalidation: { live: live('H2'), approved: false } }), 'rejected', 'fix_not_needed');
  });
  test('claim replay, unknown attempt, wrong state, not queued', () => {
    expectResult(claim(V(D({ state: 'FIXING', boundAttemptId: 'a1' }), [decidedRC], [A({ status: 'running' })])), 'duplicate', 'already_claimed');
    // A CI attempt is claimed by the repair path: not bound here (the delivery is CHANGES_REQUESTED), so it skips.
    expectResult(claim(cr([A({ family: 'ci' })])), 'rejected', 'fix_superseded');
    expectResult(claim(cr([A({ family: 'conflict' })])), 'rejected', 'fix_superseded');
    expectResult(claim(V(D({ state: 'AWAITING_REVIEW' }), [], [A()])), 'stale', 'state_moved');
    expectResult(claim(cr([A({ status: 'running' })])), 'rejected', 'attempt_not_queued');
  });
});

describe('T10 CiFailedObserved (S23, S28)', () => {
  const ci = (v: KernelView, o: Partial<Extract<Command, { type: 'CiFailedObserved' }>> = {}) =>
    run(v, { type: 'CiFailedObserved', actor: 'webhook', headSha: 'H1', signature: 'sig', maxAttempts: 3, ...o });
  test('allocates a ci ledger row at dispatch and binds it', () => {
    const dec = applied(ci(V(D({ state: 'APPROVED', approvedHeads: ['H1'] }))));
    const ins = dec.attempts[0] as { id: string; family: string; attemptNo: number };
    expect(ins).toMatchObject({ family: 'ci', attemptNo: 1, trigger: 'automatic' });
    expect(dec.patch).toMatchObject({ ci: 'red', ciHeadSha: 'H1', stateReason: 'ci', boundAttemptId: ins.id });
  });
  test('S31: a preflight-class failure is tagged preflightMiss on the transition, and changes nothing else', () => {
    const tagged = applied(ci(V(D({ state: 'AWAITING_REVIEW' })), { preflightMiss: 'No Production Data' }));
    const plain = applied(ci(V(D({ state: 'AWAITING_REVIEW' }))));
    expect(tagged.evidence).toMatchObject({ preflightMiss: 'No Production Data' });
    expect(plain.evidence).not.toHaveProperty('preflightMiss');
    expect(tagged.toState).toBe(plain.toState);
    expect(effectKinds(tagged)).toEqual(effectKinds(plain));
    // Every T10 outcome carries it: deferral while a review fix is owed, and the exhausted escalation.
    expect(applied(ci(V(D({ state: 'CHANGES_REQUESTED' })), { preflightMiss: 'x' })).evidence).toMatchObject({ preflightMiss: 'x' });
    const three = [1, 2, 3].map((n) => A({ id: `c${n}`, family: 'ci', attemptNo: n, status: 'ended' }));
    expect(applied(ci(V(D({ state: 'AWAITING_REVIEW' }), [], three), { preflightMiss: 'x' })).evidence).toMatchObject({ preflightMiss: 'x' });
  });
  test('an old-SHA failure is recorded only; CHANGES_REQUESTED keeps state', () => {
    expectResult(ci(V(D({ state: 'AWAITING_REVIEW' })), { headSha: 'H0' }), 'stale', 'head_not_current');
    const cr = applied(ci(V(D({ state: 'CHANGES_REQUESTED' }))));
    expect(cr.toState).toBe('CHANGES_REQUESTED');
    expect(cr.attempts).toEqual([]);
    expectResult(ci(V(D({ state: 'WORKING' }))), 'stale', 'state_not_allowed');
  });
  test('in-flight ci attempt defers; ledger cap escalates; human trigger recorded', () => {
    expectResult(ci(V(D({ state: 'AWAITING_REVIEW' }), [], [A({ family: 'ci', status: 'running' })])), 'rejected', 'fix_in_flight');
    const three = [1, 2, 3].map((n) => A({ id: `c${n}`, family: 'ci', attemptNo: n, status: 'ended' }));
    expect(applied(ci(V(D({ state: 'AWAITING_REVIEW' }), [], three))).patch.stateReason).toBe('ci_exhausted');
    expect(applied(ci(V(D({ state: 'AWAITING_REVIEW' })), { trigger: 'human' })).attempts[0]).toMatchObject({ trigger: 'human' });
  });
  test('S28: families count independently — review fixes never consume the ci budget', () => {
    const v = V(D({ state: 'AWAITING_REVIEW' }), [], [A({ attemptNo: 3, status: 'ended' })]);
    expect(applied(ci(v)).attempts[0]).toMatchObject({ family: 'ci', attemptNo: 1 });
  });
  test('a matching open trunk incident routes to T25 (AC-15)', () => {
    const dec = applied(ci(V(D({ state: 'AWAITING_REVIEW' })), { openTrunkIncidentId: 'i1' }));
    expect(dec.toState).toBe('BLOCKED_ON_TRUNK');
    expect(dec.attempts).toEqual([{ op: 'cancel_open', families: ['ci'], status: 'skipped' }]);
  });
  test('S24: a delivery already repairing CI joins the trunk incident; its queued attempt is skipped, not spent', () => {
    const v = V(D({ state: 'REPAIRING', stateReason: 'ci', boundAttemptId: 'c1' }), [], [A({ id: 'c1', family: 'ci', status: 'queued' })]);
    const dec = applied(ci(v, { openTrunkIncidentId: 'i1' }));
    expect(dec.toState).toBe('BLOCKED_ON_TRUNK');
    expect(dec.patch).toMatchObject({ resumeState: 'AWAITING_REVIEW', trunkIncidentId: 'i1', boundAttemptId: null });
    expect(dec.attempts).toEqual([{ op: 'cancel_open', families: ['ci'], status: 'skipped' }]);
    // Without an incident the in-flight repair still answers first.
    expectResult(ci(v), 'stale', 'state_not_allowed');
    // A review fix owes the next head: the CI fact is recorded, nothing is blocked.
    expect(applied(ci(V(D({ state: 'CHANGES_REQUESTED' })), { openTrunkIncidentId: 'i1' })).toState).toBe('CHANGES_REQUESTED');
  });
});

describe('T12 ConflictObserved: mechanical first (S27, AC-18)', () => {
  const co = (v: KernelView, o: Partial<Extract<Command, { type: 'ConflictObserved' }>> = {}) =>
    run(v, { type: 'ConflictObserved', actor: 'sweep:x', headSha: 'H1', mergeable: 'dirty', maxAgentAttempts: 3, ...o });
  const base = V(D({ state: 'AWAITING_REVIEW' }));
  test('behind / dirty → mechanical refresh with no task; migration → renumber', () => {
    const dec = applied(co(base, { mergeable: 'behind' }));
    expect(dec.attempts[0]).toMatchObject({ family: 'conflict', mode: 'mechanical', taskId: null });
    expect(effectKinds(dec)).toContain('refresh_branch');
    expect(dec.patch).toMatchObject({ stateReason: 'behind', mergeable: 'behind' });
    const mig = applied(co(base, { migrationCollision: true }));
    expect(mig.attempts[0]).toMatchObject({ family: 'migration', mode: 'mechanical' });
    expect(effectKinds(mig)).toContain('renumber_migration');
  });
  test('mechanical refusal ends the mechanical row and allocates an agent attempt', () => {
    const v = V(D({ state: 'REPAIRING', stateReason: 'conflict', boundAttemptId: 'm1' }), [], [A({ id: 'm1', family: 'conflict', mode: 'mechanical', status: 'running' })]);
    const dec = applied(co(v, { mechanicalRefused: true }));
    expect(dec.attempts[0]).toMatchObject({ op: 'update', attemptId: 'm1', set: { status: 'ended', outcome: 'failed' } });
    expect(dec.attempts[1]).toMatchObject({ op: 'insert', family: 'conflict', mode: 'agent', attemptNo: 1 });
    expect(effectKinds(dec)).toContain('dispatch_conflict_fix');
  });
  test('mechanical bound per head, agent cap, in-flight, dependency bot, stale head', () => {
    const twoMech = [A({ id: 'm1', family: 'conflict', mode: 'mechanical', status: 'ended' }), A({ id: 'm2', attemptNo: 2, family: 'conflict', mode: 'mechanical', status: 'ended' })];
    expect(applied(co(V(D({ state: 'AWAITING_REVIEW' }), [], twoMech))).attempts[0]).toMatchObject({ mode: 'agent' });
    expect(applied(co(V(D({ state: 'AWAITING_REVIEW' }), [], [...twoMech, A({ id: 'g3', attemptNo: 3, family: 'conflict', status: 'ended' })]))).patch.stateReason).toBe('conflict_exhausted');
    expectResult(co(V(D({ state: 'AWAITING_REVIEW' }), [], [...twoMech, A({ id: 'g1', family: 'conflict', status: 'running' })])), 'rejected', 'fix_in_flight');
    expectResult(co(V(D({ state: 'AWAITING_REVIEW' }), [], [A({ family: 'conflict', mode: 'mechanical', status: 'running' })])), 'rejected', 'fix_in_flight');
    expectResult(co(V(D({ state: 'REPAIRING' }))), 'rejected', 'fix_in_flight');
    expectResult(co(base, { isDependencyBot: true }), 'rejected', 'dependency_bot_pr');
    expectResult(co(base, { headSha: 'H0' }), 'stale', 'head_not_current');
    expectResult(co(V(D({ state: 'WORKING' }))), 'stale', 'state_not_allowed');
  });
  test('a mechanical refusal carries its evidence into the agent dispatch payload', () => {
    const v = V(D({ state: 'REPAIRING', stateReason: 'conflict', boundAttemptId: 'm1' }), [], [A({ id: 'm1', family: 'conflict', mode: 'mechanical', status: 'queued' })]);
    const dec = applied(co(v, { mechanicalRefused: true, refusal: { reason: 'merge conflict', semantic: null } }));
    expect(dec.effects.find((e) => e.kind === 'dispatch_conflict_fix')!.payload).toMatchObject({ repairKind: 'conflict', refusal: { reason: 'merge conflict' } });
  });
});

describe('Slice B part 2: conflict family on the live path (S15, S25, S27)', () => {
  const mech = (o: Partial<AttemptSnapshot> = {}) => A({ id: 'm1', family: 'conflict', mode: 'mechanical', status: 'queued', taskId: null, triggerReason: 'behind', ...o });
  const repairing = (o: Partial<DeliverySnapshot> = {}, attempts: AttemptSnapshot[] = [mech()]) =>
    V(D({ state: 'REPAIRING', stateReason: 'behind', boundAttemptId: attempts[0]?.id ?? null, prNumber: 7, ...o }), [], attempts);

  test('the platform refresh landing a new head ends the mechanical row (delivered) and, approved, carries the approval forward without a round', () => {
    const v = repairing({ approvedHeads: ['H1'], approvalBasis: 'verdict' });
    const dec = applied(run(v, { type: 'HeadObserved', actor: 'webhook', live: live('H2'), attribution: { descendsFromBound: true } }));
    expect(dec.toState).toBe('APPROVED');
    expect(dec.patch).toMatchObject({ currentHeadSha: 'H2', approvedHeads: ['H1', 'H2'], boundAttemptId: null });
    expect(dec.attempts[0]).toMatchObject({ op: 'update', attemptId: 'm1', set: { outcome: 'delivered', status: 'ended', pushedHeadSha: 'H2' } });
    expect(effectKinds(dec)).not.toContain('dispatch_review');
  });

  test('a mechanical renumber is not an own refresh: an approved head gets a delta round', () => {
    const v = repairing({ stateReason: 'migration', approvedHeads: ['H1'], approvalBasis: 'verdict' }, [mech({ family: 'migration', triggerReason: 'migration' })]);
    const dec = applied(run(v, { type: 'HeadObserved', actor: 'webhook', live: live('H2'), attribution: { descendsFromBound: true } }));
    expect(dec.toState).toBe('AWAITING_REVIEW');
    expect(dec.attempts[0]).toMatchObject({ set: { status: 'ended', outcome: 'delivered' } });
  });

  test('an unapproved head refreshed by the platform goes to review at the new head', () => {
    const dec = applied(run(repairing(), { type: 'HeadObserved', actor: 'webhook', live: live('H2'), attribution: { descendsFromBound: true } }));
    expect(dec.toState).toBe('AWAITING_REVIEW');
    expect(effectKinds(dec)).toContain('dispatch_review');
  });

  test('FixClaimed on a conflict agent attempt: proceeds while still conflicting; resolved meanwhile → skipped and the delivery resumes', () => {
    const agent = A({ id: 'g1', family: 'conflict', mode: 'agent', status: 'queued', triggerReason: 'conflict', taskId: 'g1' });
    const v = repairing({ stateReason: 'conflict', boundAttemptId: 'g1', approvedHeads: ['H1'], approvalBasis: 'verdict' }, [agent]);
    const go = applied(run(v, { type: 'FixClaimed', actor: 'claim:g1', attemptId: 'g1', revalidation: { live: live('H1'), approved: false } }));
    expect(go.toState).toBe('REPAIRING');
    expect(go.attempts[0]).toMatchObject({ set: { status: 'running' } });
    const resolved = applied(run(v, { type: 'FixClaimed', actor: 'claim:g1', attemptId: 'g1', revalidation: { live: live('H1'), approved: false, conflictResolved: true } }));
    expect(resolved.toState).toBe('APPROVED');
    expect(resolved.evidence.skipped).toBe('conflict_resolved');
    expect(resolved.attempts[0]).toMatchObject({ set: { status: 'skipped', outcome: 'noop' } });
    expect(resolved.patch).toMatchObject({ mergeable: 'clean', mergeableHeadSha: 'H1' });
  });

  test('MechanicalRepairFailed (operational, not a conflict) ends the row and hands landing to a person; never an agent', () => {
    const dec = applied(run(repairing(), { type: 'MechanicalRepairFailed', actor: 'effect:refresh_branch', attemptId: 'm1', reason: 'update-branch failed 3 times' }));
    expect(dec.toState).toBe('ESCALATED');
    expect(dec.patch).toMatchObject({ stateReason: 'landing_needs_human', boundAttemptId: null });
    expect(dec.attempts[0]).toMatchObject({ op: 'update', attemptId: 'm1', set: { status: 'ended', outcome: 'failed' } });
    expect(effectKinds(dec)).toContain('notify');
    expect(effectKinds(dec)).not.toContain('dispatch_conflict_fix');
    expectResult(run(repairing({ boundAttemptId: 'other' }), { type: 'MechanicalRepairFailed', actor: 'x', attemptId: 'm1', reason: 'r' }), 'stale', 'attempt_not_bound');
    expect(stableIdempotencyKey({ type: 'MechanicalRepairFailed', actor: 'x', attemptId: 'm1', reason: 'r' }, D())).toBe('mechfail:m1');
  });

  test('RepairNotNeeded on a mechanical row (already up to date) resumes and records mergeable clean', () => {
    const dec = applied(run(repairing({ approvedHeads: ['H1'], approvalBasis: 'verdict' }), { type: 'RepairNotNeeded', actor: 'effect:refresh_branch', attemptId: 'm1', reason: 'up_to_date' }));
    expect(dec.toState).toBe('APPROVED');
    expect(dec.patch).toMatchObject({ mergeable: 'clean', mergeableHeadSha: 'H1' });
  });
});

describe('T14 HumanApproved', () => {
  const ha = (v: KernelView, o: Partial<Extract<Command, { type: 'HumanApproved' }>> = {}) =>
    run(v, { type: 'HumanApproved', actor: 'human:u', reviewId: 'g1', commitId: 'H1', hasMergePermission: true, ...o });
  test('valid only for its commit_id, with merge permission, from allowed states', () => {
    expect(applied(ha(V(D({ state: 'AWAITING_REVIEW' })))).patch).toMatchObject({ approvalBasis: 'human', approvedHeads: ['H1'] });
    expectResult(ha(V(D({ state: 'AWAITING_REVIEW' })), { commitId: 'H0' }), 'stale', 'review_on_older_commit');
    expectResult(ha(V(D({ state: 'AWAITING_REVIEW' })), { hasMergePermission: false }), 'rejected', 'no_merge_permission');
    expectResult(ha(V(D({ state: 'MERGED' }))), 'stale', 'state_not_allowed');
  });
});

describe('T15 LandingRequested / T16 MergeCallResult (S10)', () => {
  const ap = (o: Partial<DeliverySnapshot> = {}) => V(D({ state: 'APPROVED', approvedHeads: ['H1'], approvalBasis: 'verdict', ...o }));
  const land = (v: KernelView, o: Partial<Extract<Command, { type: 'LandingRequested' }>> = {}) =>
    run(v, { type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live('H1'), rails: { passed: true }, ...o });
  test('merge pinned at the head; rails and coverage enforced; override never covers red CI', () => {
    expect(applied(land(ap())).effects[0]).toMatchObject({ kind: 'merge_call', payload: { headSha: 'H1' } });
    expectResult(land(ap(), { live: live('H2') }), 'stale', 'head_moved');
    expectResult(land(ap(), { live: live('H1', { state: 'closed' }) }), 'rejected', 'pr_not_open');
    expectResult(land(ap({ approvedHeads: ['H0'] })), 'rejected', 'head_not_approved');
    expectResult(land(ap(), { rails: { passed: false, reasons: ['size'] } }), 'rejected', 'rails_failed');
    expectResult(land(ap(), { rails: { passed: false, redCi: true } }), 'rejected', 'rail_not_overridable');
    expectResult(land(V(D({ state: 'CHANGES_REQUESTED' }))), 'rejected', 'state_not_allowed');
    const ov = applied(land(V(D({ state: 'ESCALATED' })), { door: 'dashboard_override', override: { reason: 'owner call' }, rails: { passed: false, reasons: ['verdict'] } }));
    expect(ov.bypass).toMatchObject({ door: 'dashboard_override', reason: 'owner call' });
    expectResult(land(V(D({ state: 'ESCALATED' })), { door: 'dashboard_override', override: { reason: 'x' }, rails: { passed: false, denyPaths: true } }), 'rejected', 'rail_not_overridable');
  });
  test('composition coverage lets a composed head land; evidence names the basis', () => {
    const dec = applied(land(ap({ approvedHeads: [], compositionHeads: ['H1'], approvalBasis: 'composition' })));
    expect(dec.evidence.coverage).toBe('composition');
  });
  const res = (v: KernelView, outcome: Extract<Command, { type: 'MergeCallResult' }>['outcome'], headSha = 'H1') =>
    run(v, { type: 'MergeCallResult', actor: 'kernel', headSha, outcome });
  test('merged/indeterminate verify via a live read; behind/conflict repair; refused escalates', () => {
    const l = V(D({ state: 'LANDING', approvedHeads: ['H1'] }));
    expect(effectKinds(applied(res(l, 'merged')))).toContain('verify_merge');
    expect(applied(res(l, 'indeterminate')).toState).toBe('LANDING');
    expect(applied(res(l, 'behind')).toState).toBe('REPAIRING');
    expect(applied(res(l, 'conflict')).patch.stateReason).toBe('conflict');
    expect(applied(res(l, 'refused')).patch.stateReason).toBe('landing_needs_human');
    expectResult(res(l, 'merged', 'H0'), 'stale', 'head_not_current');
    expectResult(res(V(D({ state: 'APPROVED' })), 'merged'), 'stale', 'state_moved');
  });
  test('not_merged (verify read shows the PR open) hands the approval back; nothing is escalated', () => {
    const dec = applied(res(V(D({ state: 'LANDING', approvedHeads: ['H1'] })), 'not_merged'));
    expect(dec.toState).toBe('APPROVED');
    expect(effectKinds(dec)).not.toContain('notify');
  });
  test('one landing per (head, version): a second door while LANDING is a duplicate; a re-landing after a refusal is a new request (Slice C)', () => {
    expectResult(land(V(D({ state: 'LANDING', approvedHeads: ['H1'] }))), 'duplicate', 'landing_in_flight');
    const at = (version: number) => V(D({ state: 'APPROVED', approvedHeads: ['H1'], approvalBasis: 'verdict', version }));
    const cmd: Command = { type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: live('H1'), rails: { passed: true } };
    expect(stableIdempotencyKey(cmd, at(4).delivery)).not.toBe(stableIdempotencyKey(cmd, at(7).delivery));
    const first = applied(land(at(4)));
    expect(first.idempotencyKey).toBe(stableIdempotencyKey(cmd, at(4).delivery));
    expect(first.effects[0]).toMatchObject({ kind: 'merge_call', dedupeKey: expect.stringContaining(':v5'), payload: { landingVersion: 5, mergeMethod: 'squash' } });
    expect(applied(land(at(7), { mergeMethod: 'rebase' })).effects[0].payload).toMatchObject({ landingVersion: 8, mergeMethod: 'rebase' });
    // The result of one landing is not mistaken for another's.
    const r = (landingVersion: number): Command => ({ type: 'MergeCallResult', actor: 'kernel', headSha: 'H1', outcome: 'refused', landingVersion });
    const l = V(D({ state: 'LANDING', approvedHeads: ['H1'] })).delivery;
    expect(stableIdempotencyKey(r(5), l)).not.toBe(stableIdempotencyKey(r(8), l));
  });
  test('the override door: a person may merge past a review verdict from the review states, never past red CI; an agent may not (§17.2)', () => {
    const human = (state: DeliverySnapshot['state']) => land(V(D({ state })), { actor: 'human:owner', door: 'dashboard', override: { reason: 'owner call' }, rails: { passed: true } });
    for (const state of ['AWAITING_REVIEW', 'CHANGES_REQUESTED', 'ESCALATED'] as const) {
      expect(applied(human(state)).bypass).toMatchObject({ door: 'dashboard', reason: 'owner call', actor: 'human:owner', overrodeState: state });
    }
    expectResult(human('REPAIRING'), 'rejected', 'state_not_allowed');
    expectResult(land(V(D({ state: 'AWAITING_REVIEW' })), { actor: 'agent:w1', door: 'merge_pr', override: { reason: 'x' } }), 'rejected', 'state_not_allowed');
    expectResult(land(V(D({ state: 'ESCALATED' })), { actor: 'human:owner', door: 'dashboard', override: { reason: 'x' }, rails: { passed: false, redCi: true } }), 'rejected', 'rail_not_overridable');
    // Without an override, a person lands only what is approved at this head.
    expectResult(land(V(D({ state: 'ESCALATED' })), { actor: 'human:owner', door: 'dashboard' }), 'rejected', 'state_not_allowed');
  });
  test('S20: a stale version from a person is answered stale with the current view; nothing applies', () => {
    const v = V(D({ state: 'APPROVED', approvedHeads: ['H1'], approvalBasis: 'verdict', version: 9 }));
    const dec = land(v, { actor: 'human:owner', door: 'dashboard', expectedVersion: 8 });
    expect(dec).toEqual({ result: 'stale', reason: 'version_moved', current: { state: 'APPROVED', version: 9, head: 'H1', round: v.delivery!.currentRound } });
    expect(applied(land(v, { actor: 'human:owner', door: 'dashboard', expectedVersion: 9 })).toState).toBe('LANDING');
  });
});

describe('T17–T21 terminal-wins and closure (S6, S11, S12, AC-8, AC-9)', () => {
  const merged = live('H1', { state: 'closed', merged: true, mergedAt: '2026-10-06T01:00:00Z', mergeCommitSha: 'M1' });
  test('PrMerged from any non-terminal state; replay duplicate; classifies review coverage', () => {
    for (const state of ['WORKING', 'FIXING', 'LANDING', 'ESCALATED', 'CLOSED_UNMERGED'] as const) {
      expect(applied(run(V(D({ state })), { type: 'PrMerged', actor: 'webhook', live: merged })).toState).toBe('MERGED');
    }
    expectResult(run(V(D({ state: 'MERGED' })), { type: 'PrMerged', actor: 'webhook', live: merged }), 'duplicate', 'already_merged');
    expectResult(run(V(D({ state: 'SUPERSEDED' })), { type: 'PrMerged', actor: 'webhook', live: merged }), 'stale', 'terminal');
    expectResult(run(V(D()), { type: 'PrMerged', actor: 'webhook', live: live('H1') }), 'rejected', 'not_merged');
    const dec = applied(run(V(D({ state: 'AWAITING_REVIEW', currentRound: 1 }), [R()], [A({ status: 'running' })]), { type: 'PrMerged', actor: 'webhook', live: merged }));
    expect(dec.patch).toMatchObject({ mergedAt: '2026-10-06T01:00:00Z', mergeCommitSha: 'M1' });
    expect(dec.evidence.reviewClass).toBe('merged_unreviewed');
    expect(dec.rounds).toEqual([{ op: 'update', roundId: 'r1', whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } }]);
    expect(effectKinds(dec)).toEqual(expect.arrayContaining(['stamp_pr_rows', 'cancel_open_attempts', 'emit_pr_merged', 'finalize_mission_pr']));
    // The mission wake and release attribution ride emit_pr_merged's one task.pr_merged fan-out.
    expect(effectKinds(dec)).not.toContain('wake_mission');
    expect(effectKinds(dec)).not.toContain('release_attribution');
    expect(applied(run(V(D({ state: 'CHANGES_REQUESTED' }), [decidedRC]), { type: 'PrMerged', actor: 'webhook', live: merged })).evidence.reviewClass).toBe('merged_over_verdict');
    expect(applied(run(V(D({ state: 'APPROVED', approvedHeads: ['H1'] })), { type: 'PrMerged', actor: 'webhook', live: merged })).evidence.reviewClass).toBe('covered:verdict');
    expect(applied(run(V(D({ state: 'APPROVED', compositionHeads: ['H1'], approvalBasis: 'composition' })), { type: 'PrMerged', actor: 'webhook', live: merged })).evidence.reviewClass).toBe('covered:composition');
  });
  test('after MERGED, late head/ci/opened facts never move it (AC-8)', () => {
    const m = V(D({ state: 'MERGED' }));
    expectResult(run(m, { type: 'HeadObserved', actor: 'webhook', live: live('H9') }), 'stale', 'terminal');
    expectResult(run(m, { type: 'CiFailedObserved', actor: 'webhook', headSha: 'H1', signature: 's', maxAttempts: 3 }), 'stale', 'state_not_allowed');
    expectResult(run(m, { type: 'PrClosedUnmerged', actor: 'webhook', live: live('H1', { state: 'closed' }), closeCause: 'manual' }), 'stale', 'terminal');
    expectResult(run(m, { type: 'PrReopened', actor: 'webhook', live: live('H1') }), 'stale', 'terminal');
  });
  test('PrClosedUnmerged / PrReopened', () => {
    expectResult(run(V(D({ state: 'CLOSED_UNMERGED' })), { type: 'PrClosedUnmerged', actor: 'webhook', live: live('H1', { state: 'closed' }), closeCause: 'manual' }), 'duplicate');
    expectResult(run(V(D()), { type: 'PrClosedUnmerged', actor: 'webhook', live: live('H1'), closeCause: 'manual' }), 'rejected', 'not_closed_unmerged');
    expect(effectKinds(applied(run(V(D()), { type: 'PrClosedUnmerged', actor: 'webhook', live: live('H1', { state: 'closed', updatedAt: 'u' }), closeCause: 'base_deleted' })))).toContain('scan_supersession');
    expectResult(run(V(D({ state: 'AWAITING_REVIEW' })), { type: 'PrReopened', actor: 'webhook', live: live('H1') }), 'duplicate', 'not_closed');
    expectResult(run(V(D({ state: 'CLOSED_UNMERGED' })), { type: 'PrReopened', actor: 'webhook', live: live('H1', { state: 'closed' }) }), 'rejected', 'pr_not_open');
  });
  test('SupersessionRecorded only from CLOSED_UNMERGED; never overwrites an edge (AC-9)', () => {
    const s = (v: KernelView, o: Partial<Extract<Command, { type: 'SupersessionRecorded' }>> = {}) =>
      run(v, { type: 'SupersessionRecorded', actor: 'agent:t2', target: { repoFullName: REPO, prNumber: 9, merged: true, url: null }, reason: 'r', authorised: true, ...o });
    const c = V(D({ state: 'CLOSED_UNMERGED' }));
    expectResult(s(V(D({ state: 'AWAITING_REVIEW' }))), 'rejected', 'not_closed_unmerged');
    expectResult(s(c, { target: { repoFullName: REPO, prNumber: 9, merged: false, url: null } }), 'rejected', 'target_not_merged');
    expectResult(s(c, { target: { repoFullName: REPO, prNumber: 7, merged: true, url: null } }), 'rejected', 'same_pr');
    expectResult(s(c, { authorised: false }), 'rejected', 'not_authorised');
    expectResult(s(c, { reason: '  ' }), 'rejected', 'reason_required');
    expectResult(s(V(D({ state: 'SUPERSEDED', supersededByPr: 9 }))), 'duplicate');
    expectResult(s(V(D({ state: 'SUPERSEDED', supersededByPr: 8 }))), 'rejected', 'edge_exists');
    expect(applied(s(c)).patch).toMatchObject({ supersededByPr: 9, recordedBy: 'agent:t2' });
  });
  test('Abandon needs a human and a reason, from CLOSED_UNMERGED', () => {
    const ab = (v: KernelView, actor = 'human:u', reason = 'dropped') => run(v, { type: 'Abandon', actor, reason });
    expectResult(ab(V(D({ state: 'CLOSED_UNMERGED' })), 'agent:x'), 'rejected', 'human_required');
    expectResult(ab(V(D({ state: 'CLOSED_UNMERGED' })), 'human:u', ''), 'rejected', 'reason_required');
    expectResult(ab(V(D({ state: 'AWAITING_REVIEW' }))), 'rejected', 'not_closed_unmerged');
    expectResult(ab(V(D({ state: 'ABANDONED' }))), 'duplicate');
    // A superseded PR already shipped: abandoning it is refused, not a silent no-op.
    expectResult(ab(V(D({ state: 'SUPERSEDED', supersededByPr: 9 }))), 'rejected', 'not_closed_unmerged');
  });
  test('T20 and T21 both project the edge onto the worker rows and wake the mission (Slice D)', () => {
    const c = V(D({ state: 'CLOSED_UNMERGED' }));
    const t20 = applied(run(c, { type: 'SupersessionRecorded', actor: 'agent:t2', target: { repoFullName: REPO, prNumber: 9, merged: true, url: null }, reason: 'r', authorised: true }));
    const t21 = applied(run(c, { type: 'Abandon', actor: 'human:u', reason: 'dropped' }));
    expect(effectKinds(t20)).toEqual(['project_supersession', 'wake_mission', 'render_activity']);
    expect(effectKinds(t21)).toEqual(['project_supersession', 'wake_mission', 'render_activity']);
    expect(t21.patch).toMatchObject({ stateReason: 'dropped', recordedBy: 'human:u' });
  });
});

describe('T22–T24', () => {
  test('PushRecoveryExhausted only from AWAITING_PUSH', () => {
    expectResult(run(V(D()), { type: 'PushRecoveryExhausted', actor: 'kernel', localHeadSha: null }), 'stale', 'state_moved');
  });
  test('HumanResolve: human + version required; each choice', () => {
    const e = V(D({ state: 'ESCALATED', stateReason: 'review_exhausted', currentRound: 3 }), [R({ id: 'r3', round: 3, status: 'decided' })]);
    const hr = (o: Partial<Extract<Command, { type: 'HumanResolve' }>>) => run(e, { type: 'HumanResolve', actor: 'human:u', choice: 'approve', expectedVersion: 5, ...o });
    expectResult(hr({ actor: 'agent:x' }), 'rejected', 'human_required');
    expectResult(hr({ expectedVersion: undefined }), 'rejected', 'expected_version_required');
    expectResult(hr({ expectedVersion: 4 }), 'stale', 'version_moved');
    expect(applied(hr({ choice: 'request_changes' })).effects[0]).toMatchObject({ kind: 'dispatch_fix', payload: { roundId: 'r3', trigger: 'human' } });
    expect(applied(hr({ choice: 'apply_recommendation' })).toState).toBe('CHANGES_REQUESTED');
    expectResult(hr({ choice: 'dismiss' }), 'rejected', 'reason_required');
    expect(applied(hr({ choice: 'dismiss', reason: 'false alarm' })).rounds).toContainEqual(expect.objectContaining({ op: 'insert', round: 4, kind: 'full' }));
    expect(applied(hr({})).idempotencyKey).toBe('resolve:d1:5');
    expectResult(run(V(D({ state: 'ESCALATED', currentHeadSha: null })), { type: 'HumanResolve', actor: 'human:u', choice: 'approve', expectedVersion: 5 }), 'rejected', 'no_head');
    expectResult(run(V(D({ state: 'ESCALATED', currentHeadSha: null })), { type: 'HumanResolve', actor: 'human:u', choice: 'dismiss', reason: 'x', expectedVersion: 5 }), 'rejected', 'no_head');
    expectResult(run(V(D({ state: 'APPROVED' })), { type: 'HumanResolve', actor: 'human:u', choice: 'approve', expectedVersion: 5 }), 'stale', 'state_moved');
  });
  test('DeliveryFailed: no PR only', () => {
    expectResult(run(V(D()), { type: 'DeliveryFailed', actor: 'runner', reason: 'x' }), 'rejected', 'pr_bound');
    expectResult(run(V(D({ state: 'FAILED' })), { type: 'DeliveryFailed', actor: 'runner', reason: 'x' }), 'duplicate');
    expectResult(run(V(D({ state: 'APPROVED', prNumber: null })), { type: 'DeliveryFailed', actor: 'runner', reason: 'x' }), 'rejected', 'state_not_allowed');
  });
});

describe('T25/T26 trunk breaker (S24)', () => {
  const tr = (v: KernelView, o: Partial<Extract<Command, { type: 'TrunkRedObserved' }>> = {}) =>
    run(v, { type: 'TrunkRedObserved', actor: 'kernel', incidentId: 'i1', signature: 'sig', headSha: 'H1', thresholdMet: true, ...o });
  test('one trunk fix per incident (dedupe key carries no delivery); ci attempts skipped; resume state recorded', () => {
    const a = applied(tr(V(D({ state: 'LANDING', approvedHeads: ['H1'] }))));
    const b = applied(tr(V(D({ id: 'd2', state: 'AWAITING_REVIEW' }))));
    const key = (x: ApplyDecision) => x.effects.find((e) => e.kind === 'dispatch_trunk_fix')!.dedupeKey;
    expect(key(a)).toBe(key(b));
    expect(a.patch.resumeState).toBe('APPROVED');
    expect(applied(tr(V(D({ state: 'REPAIRING', stateReason: 'ci' })))).patch.resumeState).toBe('AWAITING_REVIEW');
    expect(applied(tr(V(D({ state: 'REPAIRING', stateReason: 'ci', approvedHeads: ['H1'] })))).patch.resumeState).toBe('APPROVED');
  });
  test('guards', () => {
    expectResult(tr(V(D({ state: 'BLOCKED_ON_TRUNK', trunkIncidentId: 'i1' }))), 'duplicate');
    expectResult(tr(V(D({ state: 'BLOCKED_ON_TRUNK', trunkIncidentId: 'i2' }))), 'stale', 'blocked_on_other_incident');
    expectResult(tr(V(D({ state: 'AWAITING_REVIEW' })), { headSha: 'H0' }), 'stale', 'head_not_current');
    expectResult(tr(V(D({ state: 'REPAIRING', stateReason: 'conflict' }))), 'stale', 'state_not_allowed');
    expectResult(tr(V(D({ state: 'AWAITING_REVIEW' })), { thresholdMet: false }), 'rejected', 'threshold_not_met');
  });
  test('recovery re-enters resume_state; still red keeps it; AWAITING_REVIEW gets a round if none', () => {
    const b = (o: Partial<DeliverySnapshot> = {}) => V(D({ state: 'BLOCKED_ON_TRUNK', trunkIncidentId: 'i1', resumeState: 'AWAITING_REVIEW', ...o }));
    const rec = (v: KernelView, o: Partial<Extract<Command, { type: 'TrunkRecovered' }>> = {}) => run(v, { type: 'TrunkRecovered', actor: 'kernel', incidentId: 'i1', baseStillRed: false, headPredatesFix: false, ...o });
    expectResult(rec(b(), { baseStillRed: true }), 'rejected', 'trunk_still_red');
    expectResult(rec(b({ trunkIncidentId: 'i9' })), 'stale', 'not_blocked_on_incident');
    const dec = applied(rec(b()));
    expect(dec.toState).toBe('AWAITING_REVIEW');
    expect(dec.rounds).toContainEqual(expect.objectContaining({ op: 'insert', headSha: 'H1' }));
    expect(applied(rec(V(D({ state: 'BLOCKED_ON_TRUNK', trunkIncidentId: 'i1' }), [R()]))).rounds).toEqual([]);
  });
});

describe('T27 ReviewRoundFailed (S29, AC-19)', () => {
  const v = (r: Partial<RoundSnapshot> = {}) => V(D({ state: 'AWAITING_REVIEW', currentRound: 1 }), [R(r)]);
  const f = (view: KernelView, max = 2) => run(view, { type: 'ReviewRoundFailed', actor: 'reviewer', roundId: 'r1', reason: 'prose_verdict', maxContractRetries: max });
  test('re-queued at the same head and round number, then ESCALATED(review_unavailable); prose never approves', () => {
    const retry = applied(f(v()));
    expect(retry.rounds).toEqual([{ op: 'update', roundId: 'r1', whenStatus: ['queued', 'reviewing'], set: { status: 'queued', failureCount: 1, clearReviewer: true } }]);
    expect(retry.patch.currentRound).toBeUndefined();
    expect(retry.patch.approvedHeads).toBeUndefined();
    const dead = applied(f(v({ failureCount: 2 })));
    expect(dead.toState).toBe('ESCALATED');
    expect(dead.patch.stateReason).toBe('review_unavailable');
  });
  test('guards', () => {
    expectResult(f(V(D({ state: 'APPROVED' }))), 'stale', 'state_moved');
    expectResult(f(v({ status: 'decided' })), 'stale', 'round_not_current');
  });
});

describe('composition attestation: release PRs from already-reviewed changes', () => {
  const v = (o: Partial<DeliverySnapshot> = {}) => V(D({ state: 'AWAITING_REVIEW', currentRound: 1, ...o }), [R()]);
  const ca = (view: KernelView, a: Partial<CompositionAttestation> = {}, ev: ConstituentEvidence[] = attEv) =>
    run(view, { type: 'CompositionAttested', actor: 'kernel', attestation: { ...att, ...a }, constituents: ev, factId: 'f1' });

  test('no novel delta: covered by composition only — approved_heads untouched, no round decided', () => {
    const dec = applied(ca(v()));
    expect(dec.toState).toBe('APPROVED');
    expect(dec.patch).toEqual({ compositionHeads: ['H1'], approvalBasis: 'composition', stateReason: null });
    expect(dec.patch.approvedHeads).toBeUndefined();
    expect(dec.rounds).toEqual([{ op: 'update', roundId: 'r1', whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } }]);
    expect(dec.effects.some((e) => e.kind === 'post_review')).toBe(false);
    expect(dec.evidence).toMatchObject({ factId: 'f1', method: 'tree_equal', aggregateHeadSha: 'H1', novelDelta: { result: 'none' } });
    // The composed head is landable, but a reader asking for a VERDICT at it gets none.
    const after = { ...D(), approvedHeads: [], compositionHeads: ['H1'], approvalBasis: 'composition' as const };
    expect(headCoverage(after, 'H1')).toBe('composition');
  });
  test('novel delta present: a delta round scoped to the new paths, nothing approved', () => {
    const dec = applied(ca(v(), { novelDelta: { result: 'present', paths: ['packages/core/x.ts'] } }));
    expect(dec.toState).toBe('AWAITING_REVIEW');
    expect(dec.rounds).toContainEqual(expect.objectContaining({ op: 'insert', round: 2, kind: 'delta', scope: { novelDeltaPaths: ['packages/core/x.ts'], composition: true } }));
    expect(dec.patch.compositionHeads).toBeUndefined();
  });
  test('S33: an approve of the composition delta round stays a composition approval scoped to the delta', () => {
    const delta = R({ id: 'r2', round: 2, kind: 'delta', status: 'reviewing', scope: { novelDeltaPaths: ['packages/core/x.ts'], composition: true } });
    const view = V(D({ state: 'AWAITING_REVIEW', currentRound: 2 }), [R({ status: 'superseded' }), delta]);
    const dec = applied(run(view, { type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: 'r2', verdict: 'approve', effectiveVerdict: 'approve', headBound: 'H1' }));
    expect(dec.toState).toBe('APPROVED');
    // Not a whole-release verdict: the head is composition-covered, approved_heads untouched.
    expect(dec.patch).toEqual({ compositionHeads: ['H1'], approvalBasis: 'composition', stateReason: null });
    expect(dec.patch.approvedHeads).toBeUndefined();
    expect(dec.evidence).toMatchObject({ compositionDelta: { roundId: 'r2', paths: ['packages/core/x.ts'] } });
    // The GitHub review is told it covers only the delta.
    const post = dec.effects.find((e) => e.kind === 'post_review')!;
    expect(post.payload).toMatchObject({ event: 'APPROVE', commitId: 'H1', scope: { compositionDelta: true, paths: ['packages/core/x.ts'] } });
    expect(headCoverage({ ...D(), approvedHeads: [], compositionHeads: ['H1'], approvalBasis: 'composition' }, 'H1')).toBe('composition');
  });
  test('an ordinary delta round (changes since the last verdict) still approves on its verdict', () => {
    const delta = R({ id: 'r2', round: 2, kind: 'delta', status: 'reviewing' });
    const view = V(D({ state: 'AWAITING_REVIEW', currentRound: 2 }), [R({ status: 'decided' }), delta]);
    const dec = applied(run(view, { type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: 'r2', verdict: 'approve', effectiveVerdict: 'approve', headBound: 'H1' }));
    expect(dec.patch).toMatchObject({ approvedHeads: ['H1'], approvalBasis: 'verdict' });
  });
  test('unverifiable, wrong PR, wrong head, wrong state and failed verification claim nothing', () => {
    expectResult(ca(v(), { novelDelta: { result: 'unverifiable', reason: 'tree mismatch' } }), 'rejected', 'composition_unverifiable');
    expectResult(ca(v(), { prNumber: 8 }), 'rejected', 'attestation_pr_mismatch');
    expectResult(ca(v(), { aggregateHeadSha: 'H0' }), 'stale', 'head_not_current');
    expectResult(ca(v({ state: 'APPROVED' })), 'stale', 'state_not_allowed');
    const bad = ca(v(), {}, [{ ...attEv[0], roundHeadSha: 'C0' }]);
    expectResult(bad, 'rejected', 'composition_not_verified');
    expect((bad as { missing: string[] }).missing).toEqual(['constituent_head_mismatch:rx']);
  });

  test('verifyCompositionAttestation: exact-head binding of every constituent', () => {
    const ok = verifyCompositionAttestation(att, attEv);
    expect(ok).toEqual({ ok: true, reasons: [] });
    const eq = { ...att, constituents: [{ ...att.constituents[0], equivalentHeadShas: ['C2'], mergedHeadSha: 'C2' }] };
    expect(verifyCompositionAttestation(eq, [{ ...attEv[0], deliveryApprovedHeads: ['C1', 'C2'] }]).ok).toBe(true);
    expect(verifyCompositionAttestation(eq, attEv).reasons).toEqual(['constituent_equivalence_unrecorded:rx', 'constituent_landed_unproven:rx']);
    expect(verifyCompositionAttestation({ ...att, constituents: [{ ...att.constituents[0], mergedHeadSha: 'C9' }] }, attEv).reasons).toEqual(['constituent_landed_unproven:rx']);
    // The patch proof: equal, well-formed patch-ids from the landed commit and the reviewed head.
    expect(verifyCompositionAttestation({ ...att, constituents: [{ ...att.constituents[0], reviewedPatchId: 'b'.repeat(64) }] }, attEv).reasons).toEqual(['constituent_patch_unproven:rx']);
    expect(verifyCompositionAttestation({ ...att, constituents: [{ ...att.constituents[0], landedPatchId: '', reviewedPatchId: '' }] }, attEv).reasons).toEqual(['constituent_patch_unproven:rx']);
    const legacy = { ...att.constituents[0] } as Partial<typeof att.constituents[0]>;
    delete legacy.landedPatchId; delete legacy.reviewedPatchId;
    expect(verifyCompositionAttestation({ ...att, constituents: [legacy as typeof att.constituents[0]] }, attEv).reasons).toEqual(['constituent_patch_unproven:rx']);
    // The cited round must belong to the constituent's own delivery and PR.
    expect(verifyCompositionAttestation(att, [{ ...attEv[0], prNumber: 4 }]).reasons).toEqual(['constituent_round_foreign:rx']);
    expect(verifyCompositionAttestation(att, [{ ...attEv[0], deliveryId: 'dy' }]).reasons).toEqual(['constituent_round_foreign:rx']);
    expect(verifyCompositionAttestation(att, [{ ...attEv[0], repoFullName: 'acme/other' }]).reasons).toEqual(['constituent_round_foreign:rx']);
    expect(verifyCompositionAttestation(att, [{ ...attEv[0], effectiveVerdict: 'request_changes' }]).reasons).toEqual(['constituent_not_approved:rx']);
    expect(verifyCompositionAttestation(att, []).reasons).toEqual(['constituent_unresolved:rx']);
    expect(verifyCompositionAttestation({ ...att, constituents: [att.constituents[0], att.constituents[0]] }, attEv).reasons).toEqual(['duplicate_constituent:rx']);
    expect(verifyCompositionAttestation({ ...att, constituents: [] }, []).reasons).toEqual(['no_constituents']);
    expect(verifyCompositionAttestation({ ...att, aggregateHeadSha: 'B0' }, attEv).reasons).toEqual(['aggregate_equals_base']);
    expect(verifyCompositionAttestation({ ...att, aggregateHeadSha: '' }, attEv).reasons).toContain('aggregate_head_missing');
    expect(verifyCompositionAttestation({ ...att, method: 'judgement' as never }, attEv).reasons).toEqual(['method_not_mechanical']);
    expect(verifyCompositionAttestation({ ...att, novelDelta: { result: 'present', paths: [] } }, attEv).reasons).toEqual(['novel_delta_paths_missing']);
  });
  test('an ordinary verdict is still exact-head: composition never satisfies a verdict lookup', () => {
    const d = D({ approvedHeads: ['H1'], approvalBasis: 'verdict', compositionHeads: ['H2'] });
    expect(headCoverage(d, 'H1')).toBe('verdict');
    expect(headCoverage(d, 'H2')).toBe('composition');
    expect(headCoverage(d, 'H3')).toBe('none');
    expect(headCoverage(d, null)).toBe('none');
    expect(headCoverage(D({ approvedHeads: ['H1'], approvalBasis: 'human' }), 'H1')).toBe('human');
  });
  test('carry-forward under a composition approval extends composition heads, not approved heads', () => {
    const dec = applied(run(V(D({ state: 'APPROVED', compositionHeads: ['H1'], approvalBasis: 'composition' })), { type: 'HeadObserved', actor: 'kernel', live: live('H2'), carryForward: 'own_refresh' }));
    expect(dec.patch.compositionHeads).toEqual(['H1', 'H2']);
    expect(dec.patch.approvedHeads).toBeUndefined();
  });
});

test('row ids default to random UUIDs when no generator is injected', () => {
  const dec = reduce(V(D({ state: 'AWAITING_REVIEW' })), { type: 'CiFailedObserved', actor: 'w', headSha: 'H1', signature: 's', maxAttempts: 3 });
  if (dec.result !== 'apply') throw new Error('expected apply');
  expect((dec.attempts[0] as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
});

describe('pure helpers', () => {
  test('deliveryProof (§9)', () => {
    expect(deliveryProof({ boundHeadSha: 'H1', localHeadSha: 'L2', liveHeadSha: 'H1' })).toEqual({ holds: false, reason: 'head_not_advanced' });
    expect(deliveryProof({ boundHeadSha: 'H1', localHeadSha: 'L2', liveHeadSha: 'L2' }).holds).toBe(true);
    expect(deliveryProof({ boundHeadSha: 'H1', localHeadSha: 'L2', liveHeadSha: 'M3', liveContainsLocal: true }).holds).toBe(true);
    expect(deliveryProof({ boundHeadSha: 'H1', localHeadSha: 'L2', liveHeadSha: 'M3' }).reason).toBe('live_head_missing_local');
    expect(deliveryProof({ boundHeadSha: 'H1', localHeadSha: null, liveHeadSha: 'M3' }).reason).toBe('local_head_unknown');
    expect(deliveryProof({ boundHeadSha: 'H1', localHeadSha: null, liveHeadSha: 'M3', contentDiffChanged: true }).holds).toBe(true);
    expect(deliveryProof({ boundHeadSha: 'H1', localHeadSha: 'L2', liveHeadSha: null }).reason).toBe('no_live_head');
  });
  test('attemptView is 1-based, per family, ignores skipped rows (S28)', () => {
    const rows = [A({ family: 'ci', attemptNo: 1, status: 'ended' }), A({ family: 'ci', attemptNo: 2, status: 'skipped' }), A({ attemptNo: 2, maxAttempts: 5 })];
    expect(attemptView(rows, 'ci')).toEqual({ n: 1, m: 3 });
    // N is the count of dispatched rows (1-based), M the highest cap any of them carries.
    expect(attemptView(rows, 'review_fix')).toEqual({ n: 1, m: 5 });
    expect(attemptView(rows, 'conflict')).toEqual({ n: 0, m: 3 });
  });
  test('stableIdempotencyKey is null without the identity it needs', () => {
    expect(stableIdempotencyKey({ type: 'PrMerged', actor: 'w', live: live('H1') }, D({ prNumber: null }))).toBeNull();
    expect(stableIdempotencyKey({ type: 'ReviewBudgetExhausted', actor: 'k' }, D())).toBeNull();
    expect(stableIdempotencyKey({ type: 'DeliveryFailed', actor: 'k', reason: 'x' }, null)).toBeNull();
    expect(stableIdempotencyKey({ type: 'HeadObserved', actor: 'k', live: live('H2') }, D())).toBe(`head:${REPO}#7:H1->H2@v5`);
  });
});

// ── Slice A part 2: the CI family on the ledger (§5.7, §6.9, §10.5, AC-13/14/16) ──

describe('CI family (S23, S25, S28, AC-13/14/16)', () => {
  const ciAttempt = (o: Partial<AttemptSnapshot> = {}) => A({ id: 'c1', family: 'ci', triggerReason: 'sig', ...o });
  const repairing = (a: AttemptSnapshot[], d: Partial<DeliverySnapshot> = {}) =>
    V(D({ state: 'REPAIRING', stateReason: 'ci', boundAttemptId: 'c1', currentRound: 1, ...d }), [R({ status: 'queued' })], a);
  const head = (v: KernelView, h: string, extra: Partial<Extract<Command, { type: 'HeadObserved' }>> = {}) =>
    run(v, { type: 'HeadObserved', actor: 'webhook', live: live(h), ...extra } as Command);
  const ciFail = (v: KernelView, o: Partial<Extract<Command, { type: 'CiFailedObserved' }>> = {}) =>
    run(v, { type: 'CiFailedObserved', actor: 'webhook', headSha: 'H1', signature: 'sig', maxAttempts: 3, ...o } as Command);

  test('S23: a push the running attempt reported, or that descends from its head, is its delivery, whoever authored it', () => {
    for (const attribution of [undefined, { descendsFromBound: true }]) {
      const dec = applied(head(repairing([ciAttempt({ status: 'running' })]), 'H2', attribution ? { attribution } : {}));
      expect(dec.toState).toBe('AWAITING_REVIEW');
      expect(dec.attempts[0]).toMatchObject({ attemptId: 'c1', set: { outcome: 'delivered', pushedHeadSha: 'H2', appendReportedSha: 'H2' } });
      expect(dec.attempts.some((x) => x.op === 'insert')).toBe(false);
    }
    // A SHA in reported_shas is the attempt's even when the compare API says otherwise.
    const reported = applied(head(repairing([ciAttempt({ status: 'running', reportedShas: ['H2'] })]), 'H2', { attribution: { descendsFromBound: false } }));
    expect(reported.toState).toBe('AWAITING_REVIEW');
  });

  test('S23: a person pushing while a CI fix is only queued skips that row (no budget) and handles the head normally', () => {
    const dec = applied(head(repairing([ciAttempt({ status: 'queued' })]), 'HUMAN1', { attribution: { descendsFromBound: true } }));
    expect(dec.toState).toBe('AWAITING_REVIEW');
    expect(dec.attempts).toEqual([{ op: 'update', attemptId: 'c1', whenStatus: ['queued'], set: { status: 'skipped', outcome: 'noop', ended: true } }]);
    expect(dec.effects.find((e) => e.kind === 'cancel_open_attempts')?.payload).toEqual({ families: ['ci'], reason: 'head_moved' });
    expect(dec.evidence).toMatchObject({ foreignPush: true, repairSkipped: true });
    expect(dec.patch.boundAttemptId).toBeNull();
    const ap = applied(head(repairing([ciAttempt()], { approvedHeads: ['H1'], approvalBasis: 'verdict' }), 'H2', { carryForward: 'content_equivalent' }));
    expect(ap.toState).toBe('APPROVED');
    expect(ap.patch).toMatchObject({ approvedHeads: ['H1', 'H2'], boundAttemptId: null });
  });

  test('S23: the cap bounds dispatches in every case; a skipped row frees its slot, every other row spends one', () => {
    const rows = [ciAttempt({ id: 'p1', attemptNo: 1, status: 'ended', outcome: 'delivered' }), ciAttempt({ id: 'p2', attemptNo: 2, status: 'skipped' }), ciAttempt({ id: 'p3', attemptNo: 3, status: 'cancelled' })];
    const next = applied(ciFail(V(D({ state: 'AWAITING_REVIEW' }), [], rows)));
    expect(next.toState).toBe('REPAIRING');
    expect(next.attempts[0]).toMatchObject({ op: 'insert', family: 'ci', attemptNo: 4, maxAttempts: 3 });
    expect(next.evidence).toMatchObject({ spent: 3, max: 3 });
    const full = [...rows, ciAttempt({ id: 'p4', attemptNo: 4, status: 'ended' })];
    expect(applied(ciFail(V(D({ state: 'AWAITING_REVIEW' }), [], full))).toState).toBe('ESCALATED');
  });

  test('AC-14: a human "Fix CI" past the cap is refused by T10 and allowed only as BudgetExtended, numbered after the last', () => {
    const spent = [1, 2, 3].map((n) => ciAttempt({ id: `c${n}`, attemptNo: n, status: 'ended' }));
    expectResult(ciFail(V(D({ state: 'ESCALATED', stateReason: 'ci_exhausted' }), [], spent), { trigger: 'human', actor: 'human:u' }), 'rejected', 'budget_exhausted');
    const ext = (o: Partial<Extract<Command, { type: 'BudgetExtended' }>> = {}) => run(V(D({ state: 'ESCALATED', stateReason: 'ci_exhausted' }), [], spent),
      { type: 'BudgetExtended', actor: 'human:u', family: 'ci', headSha: 'H1', signature: 'sig', maxAttempts: 3, reason: 'one more', ...o } as Command);
    const dec = applied(ext());
    expect(dec.toState).toBe('REPAIRING');
    expect(dec.attempts[0]).toMatchObject({ op: 'insert', attemptNo: 4, trigger: 'human', maxAttempts: 4 });
    expect(dec.bypass).toMatchObject({ actor: 'human:u', budgetFrom: 3, budgetTo: 4 });
    expect(dec.idempotencyKey).toBe('budget:d1:ci:4');
    expectResult(ext({ actor: 'runner' }), 'rejected', 'human_required');
    expectResult(ext({ reason: ' ' }), 'rejected', 'reason_required');
    // Under the cap there is nothing to extend: the human retry is an ordinary T10 attempt.
    expectResult(run(V(D({ state: 'AWAITING_REVIEW' })), { type: 'BudgetExtended', actor: 'human:u', family: 'ci', headSha: 'H1', signature: 'sig', maxAttempts: 3, reason: 'x' }), 'rejected', 'budget_not_exhausted');
    const human = applied(ciFail(V(D({ state: 'AWAITING_REVIEW' })), { trigger: 'human', actor: 'human:u' }));
    expect(human.attempts[0]).toMatchObject({ attemptNo: 1, trigger: 'human', maxAttempts: 3 });
    // The extension raises the cap by exactly one: the next automatic failure escalates again.
    const extended = [...spent, ciAttempt({ id: 'c4', attemptNo: 4, status: 'ended', trigger: 'human', maxAttempts: 4 })];
    expect(applied(ciFail(V(D({ state: 'AWAITING_REVIEW' }), [], extended))).patch.stateReason).toBe('ci_exhausted');
  });

  test('S25/AC-16: CI green at claim or dispatch skips the row and resumes; a moved head or closed PR only skips', () => {
    const claimCi = (v: KernelView, rev: { live: LivePr; approved: boolean; ciGreen?: boolean }) =>
      run(v, { type: 'FixClaimed', actor: 'claim:x', attemptId: 'c1', revalidation: rev } as Command);
    const ok = applied(claimCi(repairing([ciAttempt()]), { live: live('H1'), approved: false }));
    expect(ok.toState).toBe('REPAIRING');
    expect(ok.attempts).toEqual([{ op: 'update', attemptId: 'c1', whenStatus: ['queued'], set: { status: 'running' } }]);
    expectResult(claimCi(repairing([ciAttempt({ status: 'running' })]), { live: live('H1'), approved: false }), 'duplicate', 'already_claimed');
    const green = applied(claimCi(repairing([ciAttempt()]), { live: live('H1'), approved: false, ciGreen: true }));
    expect(green.toState).toBe('AWAITING_REVIEW');
    expect(green.evidence.skipped).toBe('ci_green');
    expect(green.patch).toMatchObject({ ci: 'green', boundAttemptId: null });
    expect(green.rounds).toEqual([]); // round 1 is still open at H1
    for (const l of [live('H9'), live('H1', { state: 'closed' })]) {
      const dec = claimCi(repairing([ciAttempt()]), { live: l, approved: false });
      expectResult(dec, 'rejected', 'fix_not_needed');
      expect((dec as { record: { attempts: unknown[] } }).record.attempts).toHaveLength(1);
    }
    const notNeeded = applied(run(repairing([ciAttempt()]), { type: 'RepairNotNeeded', actor: 'kernel', attemptId: 'c1', reason: 'ci_green' }));
    expect(notNeeded.toState).toBe('AWAITING_REVIEW');
    expect(notNeeded.idempotencyKey).toBe('notneeded:c1');
    // No open round at the head: one is queued so the delivery has an owner.
    const noRound = applied(run(V(D({ state: 'REPAIRING', stateReason: 'ci', boundAttemptId: 'c1' }), [], [ciAttempt()]), { type: 'RepairNotNeeded', actor: 'kernel', attemptId: 'c1', reason: 'ci_green' }));
    expect(effectKinds(noRound)).toContain('dispatch_review');
  });

  test('S28: families count independently; a review fix on a delivery that spent CI attempts starts at 1', () => {
    const rows = [ciAttempt({ id: 'c1', attemptNo: 1, status: 'ended' }), ciAttempt({ id: 'c2', attemptNo: 2, status: 'ended' }), A({ id: 'm1', family: 'conflict', mode: 'mechanical', attemptNo: 1, status: 'ended', maxAttempts: 2 })];
    expect(attemptView(rows, 'ci')).toEqual({ n: 2, m: 3 });
    expect(attemptView(rows, 'review_fix')).toEqual({ n: 0, m: 3 });
    expect(attemptView(rows, 'conflict')).toEqual({ n: 0, m: 3 }); // mechanical rows never count against the agent budget
    const dec = applied(run(V(D({ state: 'CHANGES_REQUESTED', currentRound: 1 }), [decidedRC], rows), { type: 'FixDispatched', actor: 'kernel', roundId: 'r1', taskId: 'ft', maxAttempts: 3, revalidation: { live: live('H1'), newerApprove: false } }));
    expect(dec.attempts[0]).toMatchObject({ family: 'review_fix', attemptNo: 1 });
  });

  test('an attempt that ends after the delivery moved on records its end without moving the delivery', () => {
    const v = V(D({ state: 'AWAITING_REVIEW', currentRound: 2, currentHeadSha: 'H2' }), [], [ciAttempt({ status: 'running', outcome: 'delivered' })]);
    const dec = run(v, { type: 'AttemptEnded', actor: 'runner', workerId: 'w', attemptId: 'c1', outcome: 'success', localHeadSha: 'H2', commitCount: 1, live: live('H2') });
    expectResult(dec, 'stale', 'attempt_not_bound');
    expect((dec as { record: { attempts: Array<{ set: Record<string, unknown> }> } }).record.attempts[0].set).toEqual({ status: 'ended', ended: true, appendReportedSha: 'H2' });
  });
});

describe('S9, S12, S15 kernel rules', () => {
  test('S9: an owner attempt reaped with commits and no reported head is not proof: AWAITING_PUSH + push_recovery', () => {
    const dec = applied(run(V(D()), { type: 'AttemptEnded', actor: 'sweep:stale-workers', workerId: 'w', taskId: 't1', outcome: 'lost', localHeadSha: null, commitCount: 2, live: live('H1') }));
    expect(dec.toState).toBe('AWAITING_PUSH');
    expect(effectKinds(dec)).toContain('push_recovery');
    // Nothing local to lose: a reaped attempt with no commits hands on as before.
    expect(applied(run(V(D()), { type: 'AttemptEnded', actor: 'sweep:stale-workers', workerId: 'w', taskId: 't1', outcome: 'lost', localHeadSha: null, commitCount: 0, live: live('H1') })).toState).toBe('AWAITING_REVIEW');
  });

  test('S12: a second, different supersession target reaches the reducer and is refused; the same one is a replay', () => {
    const cmd = (prNumber: number): Command => ({ type: 'SupersessionRecorded', actor: 'agent:t2', target: { repoFullName: REPO, prNumber, merged: true, url: null }, reason: 'r', authorised: true });
    const sup = V(D({ state: 'SUPERSEDED', supersededByPr: 9 }));
    expect(stableIdempotencyKey(cmd(9), sup.delivery)).not.toBe(stableIdempotencyKey(cmd(10), sup.delivery));
    expectResult(run(sup, cmd(10)), 'rejected', 'edge_exists');
    expectResult(run(sup, cmd(9)), 'duplicate', 'edge_exists_same');
  });

  test('S15: a base that keeps moving is refreshed mechanically a bounded number of times across heads, then a person lands it', () => {
    const behind = (n: number) => Array.from({ length: n }, (_, i) => A({ id: `m${i}`, family: 'conflict', mode: 'mechanical', attemptNo: i + 1, boundHeadSha: `B${i}`, triggerReason: 'behind', status: 'ended', maxAttempts: 2 }));
    const mc = (rows: AttemptSnapshot[]) => run(V(D({ state: 'LANDING', approvedHeads: ['H1'], approvalBasis: 'verdict' }), [], rows), { type: 'MergeCallResult', actor: 'kernel', headSha: 'H1', outcome: 'behind' });
    const first = applied(mc(behind(2)));
    expect(first.toState).toBe('REPAIRING');
    expect(effectKinds(first)).toContain('refresh_branch');
    const capped = applied(mc(behind(3)));
    expect(capped.toState).toBe('ESCALATED');
    expect(capped.patch.stateReason).toBe('landing_needs_human');
    expect(capped.attempts).toEqual([]);
  });
});
