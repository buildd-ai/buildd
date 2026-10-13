/**
 * Conformance on the pure core (docs/specs/workflow-kernel-library.md §2,
 * AC-6): the kernel driven through commands by the in-memory host, with no
 * database, no GitHub and no buildd import. Rows are named for the
 * docs/specs/workflow-state-kernel.md §16 matrix (S-numbers) and for the
 * incident sequences of the library spec (#4686, #4679). A rule the reducer
 * does not implement yet is a `test.todo` naming its acceptance criterion.
 */
import { describe, expect, test } from 'bun:test';
import type { Command, LivePr } from '../commands';
import { deriveDeliveryView } from '../projections';
import { InMemoryKernel, type CommandResult, type DeliveryRef } from './harness';

const REPO = 'acme/widgets';
const WS = 'w1';
const OWNER = 't1';
const live = (headSha: string, o: Partial<LivePr> = {}): LivePr => ({ state: 'open', merged: false, headSha, headRepoFullName: REPO, baseRef: 'dev', ...o });
const mergedLive = (headSha: string): LivePr => live(headSha, { state: 'closed', merged: true, mergedAt: '2026-01-01T01:00:00.000Z', mergeCommitSha: 'M1' });

/** One delivery under test, with the moves a host makes on its behalf. */
class Scenario {
  readonly k = new InMemoryKernel();
  readonly ref: DeliveryRef = { workspaceId: WS, ownerTaskId: OWNER };
  private worker = 0;

  submit(cmd: Command): CommandResult { return this.k.submit(cmd, this.ref); }
  get view() { return this.k.view(this.ref); }
  get d() { return this.view.delivery!; }
  get state() { return this.d.state; }
  get rounds() { return this.view.rounds; }
  get latestRound() { return this.rounds.at(-1)!; }
  effectKinds(): string[] { return this.k.effects(this.d.id).map((e) => e.kind); }
  count(kind: string): number { return this.effectKinds().filter((k) => k === kind).length; }

  open(): this {
    expectApplied(this.k.submit({ type: 'DeliveryOpened', actor: 'runner', workspaceId: WS, ownerTaskId: OWNER, requiresPr: true }), 'WORKING');
    expectApplied(this.submit({ type: 'PrBound', actor: 'runner', repoFullName: REPO, prNumber: 7, live: live('H1') }), 'WORKING');
    return this;
  }
  /** The owner attempt ends with its head on GitHub: the delivery goes to review. */
  ownerPushed(head = 'H1'): CommandResult {
    return this.submit({ type: 'AttemptEnded', actor: 'runner', workerId: `wk${++this.worker}`, taskId: OWNER, outcome: 'success', localHeadSha: head, commitCount: 1, live: live(head) });
  }
  verdict(verdict: 'approve' | 'request_changes', roundId = this.latestRound.id, headBound = this.rounds.find((r) => r.id === roundId)!.headSha): CommandResult {
    return this.submit({ type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId, verdict, effectiveVerdict: verdict, headBound });
  }
  /** T8 then T9: the fix is dispatched for the current round and claimed. Returns its attempt id. */
  startFix(taskId = 'ft1'): string {
    const head = this.d.currentHeadSha!;
    expectApplied(this.submit({ type: 'FixDispatched', actor: 'kernel', roundId: this.latestRound.id, taskId, maxAttempts: 3, revalidation: { live: live(head), newerApprove: false } }), 'CHANGES_REQUESTED');
    const attempt = this.view.attempts.find((a) => a.family === 'review_fix' && a.status === 'queued')!;
    expectApplied(this.submit({ type: 'FixClaimed', actor: 'runner', attemptId: attempt.id, revalidation: { live: live(head), approved: false } }), 'FIXING');
    return attempt.id;
  }
  push(head: string, o: Partial<Extract<Command, { type: 'HeadObserved' }>> = {}): CommandResult {
    return this.submit({ type: 'HeadObserved', actor: 'webhook', live: live(head), ...o });
  }
  fixEnded(attemptId: string, o: Partial<Extract<Command, { type: 'AttemptEnded' }>>): CommandResult {
    return this.submit({ type: 'AttemptEnded', actor: 'runner', workerId: `wk${++this.worker}`, taskId: 'ft1', attemptId, outcome: 'success', localHeadSha: null, commitCount: 0, live: live(this.d.currentHeadSha!), ...o });
  }
  land(head: string): CommandResult {
    return this.submit({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: head, live: live(head), rails: { passed: true } });
  }
}

function expectApplied(r: CommandResult, toState: string): void {
  expect({ result: r.result, reason: 'reason' in r ? r.reason : undefined, to: r.result === 'applied' ? r.decision.toState : undefined })
    .toEqual({ result: 'applied', reason: undefined, to: toState as never });
}
function expectNotApplied(r: CommandResult, result: 'duplicate' | 'stale' | 'rejected', reason: string): void {
  expect({ result: r.result, reason: 'reason' in r ? r.reason : undefined }).toEqual({ result, reason });
}

describe('the in-memory host', () => {
  test('every applied transition bumps the version by one and is recorded once, at the clock', () => {
    const s = new Scenario().open();
    s.k.clock.advance(60_000);
    s.ownerPushed();
    const ts = s.k.transitions(s.d.id);
    expect(ts.map((t) => t.toVersion)).toEqual([1, 2, 3]);
    expect(ts.map((t) => t.fromVersion)).toEqual([0, 1, 2]);
    expect(ts.at(-1)!.at).toBe('2026-01-01T00:01:00.000Z');
    expect(s.d.version).toBe(3);
  });

  test('ids are deterministic: two runs of the same sequence allocate the same ids', () => {
    const a = new Scenario().open(); a.ownerPushed();
    const b = new Scenario().open(); b.ownerPushed();
    expect(a.view).toEqual(b.view);
  });

  test('a decision written against a version that moved is a CAS miss, and nothing is written', () => {
    const s = new Scenario().open();
    const before = s.view;
    const dec = s.k.submit({ type: 'HeadObserved', actor: 'webhook', live: live('H2') }, s.ref);
    expect(dec.result).toBe('applied');
    if (dec.result !== 'applied') return;
    // Replay the same decision: its guard names the version it read, which is gone.
    expect(s.k.store.applyTransition(dec.decision, s.d.id)).toBeNull();
    expect(s.d.version).toBe(before.delivery!.version + 1);
  });
});

describe('§16 pure rows on the in-memory host', () => {
  test('happy path: open → review → changes requested → fix pushed → re-review → approved → landing → merged', () => {
    const s = new Scenario().open();
    expectApplied(s.ownerPushed('H1'), 'AWAITING_REVIEW');
    expect(s.latestRound).toMatchObject({ round: 1, headSha: 'H1', kind: 'full', status: 'queued' });

    expectApplied(s.verdict('request_changes'), 'CHANGES_REQUESTED');
    expect(s.effectKinds()).toEqual(expect.arrayContaining(['post_review', 'dispatch_fix']));

    const fix = s.startFix();
    // The fix's own push, attributed to it mid-attempt: recorded as provenance, state unchanged.
    expectApplied(s.push('H2', { attribution: { descendsFromBound: true } }), 'FIXING');
    expect(s.view.attempts.find((a) => a.id === fix)!.reportedShas).toEqual(['H2']);

    expectApplied(s.fixEnded(fix, { localHeadSha: 'H2', commitCount: 1, live: live('H2'), proof: { liveContainsLocal: true } }), 'AWAITING_REVIEW');
    expect(s.latestRound).toMatchObject({ round: 2, headSha: 'H2', kind: 'delta', status: 'queued' });
    expect(s.view.attempts.find((a) => a.id === fix)).toMatchObject({ status: 'ended', outcome: 'delivered' });

    expectApplied(s.verdict('approve'), 'APPROVED');
    expect(s.d).toMatchObject({ approvedHeads: ['H2'], approvalBasis: 'verdict' });

    expectApplied(s.land('H2'), 'LANDING');
    expect(s.k.effects(s.d.id, 'merge_call').map((e) => e.payload.headSha)).toEqual(['H2']);
    expectApplied(s.submit({ type: 'MergeCallResult', actor: 'kernel', headSha: 'H2', outcome: 'merged' }), 'LANDING');
    expectApplied(s.submit({ type: 'PrMerged', actor: 'webhook', live: mergedLive('H2') }), 'MERGED');
    expect(s.d).toMatchObject({ mergedAt: '2026-01-01T01:00:00.000Z', mergeCommitSha: 'M1' });
  });

  test('S2: a head advance invalidates the approval: a delta round at the new head, and the old approval does not land it', () => {
    const s = new Scenario().open();
    s.ownerPushed('H1');
    expectApplied(s.verdict('approve'), 'APPROVED');
    expectApplied(s.push('H2'), 'AWAITING_REVIEW');
    expect(s.latestRound).toMatchObject({ round: 2, headSha: 'H2', kind: 'delta', status: 'queued' });
    expect(s.d.approvedHeads).not.toContain('H2');
    expectNotApplied(s.land('H2'), 'rejected', 'state_not_allowed');
    expect(s.k.effects(s.d.id, 'merge_call')).toEqual([]);
  });

  test('S5: a duplicate event is idempotent: same key answers duplicate and owes no second effect', () => {
    const s = new Scenario().open();
    s.ownerPushed('H1');
    const before = { version: s.d.version, effects: s.effectKinds() };
    // The same worker exit delivered twice.
    expectNotApplied(s.submit({ type: 'AttemptEnded', actor: 'runner', workerId: 'wk1', taskId: OWNER, outcome: 'success', localHeadSha: 'H1', commitCount: 1, live: live('H1') }), 'duplicate', 'idempotency_key_seen');
    // The same reviewer verdict delivered twice.
    expectApplied(s.verdict('request_changes'), 'CHANGES_REQUESTED');
    const after = { version: s.d.version, effects: s.effectKinds() };
    expectNotApplied(s.verdict('request_changes', s.rounds[0]!.id), 'duplicate', 'idempotency_key_seen');
    expect({ version: s.d.version, effects: s.effectKinds() }).toEqual(after);
    expect(after.version).toBe(before.version + 1);
    // The same merge webhook twice.
    expectApplied(s.submit({ type: 'PrMerged', actor: 'webhook', live: mergedLive('H1') }), 'MERGED');
    expectNotApplied(s.submit({ type: 'PrMerged', actor: 'webhook', live: mergedLive('H1') }), 'duplicate', 'idempotency_key_seen');
    expect(s.count('emit_pr_merged')).toBe(1);
  });

  test('S20: a stale version from a person is answered stale with the current view; nothing applies', () => {
    const s = new Scenario().open();
    s.ownerPushed('H1');
    const seen = s.d.version;
    s.push('H2'); // the delivery moves on after the person read it
    const r = s.submit({ type: 'HumanResolve', actor: 'human:u', choice: 'approve', expectedVersion: seen, commitId: 'H1', hasMergePermission: true });
    expectNotApplied(r, 'stale', 'version_moved');
    expect(r.result !== 'applied' && r.current).toEqual({ state: 'AWAITING_REVIEW', version: seen + 1, head: 'H2', round: 2 });
    expect(s.d.version).toBe(seen + 1);
  });

  test('S6: terminal wins: after MERGED a late head is not applied', () => {
    const s = new Scenario().open();
    s.ownerPushed('H1');
    expectApplied(s.submit({ type: 'PrMerged', actor: 'webhook', live: mergedLive('H1') }), 'MERGED');
    expectNotApplied(s.push('H9'), 'stale', 'terminal');
    expect(s.state).toBe('MERGED');
  });
});

describe('#4686: a review fix that changes nothing', () => {
  const requested = () => {
    const s = new Scenario().open();
    s.ownerPushed('H1');
    expectApplied(s.verdict('request_changes'), 'CHANGES_REQUESTED');
    return { s, fix: s.startFix() };
  };

  test('a fix that ends with no push and nothing to show leaves the delivery in changes-required, with the next attempt owed', () => {
    const { s, fix } = requested();
    expectApplied(s.fixEnded(fix, { outcome: 'unproven', localHeadSha: null, commitCount: 0 }), 'CHANGES_REQUESTED');
    expect(s.view.attempts.find((a) => a.id === fix)).toMatchObject({ status: 'ended', outcome: 'failed' });
    expect(s.k.effects(s.d.id, 'dispatch_fix').map((e) => e.payload.attemptNo)).toEqual([1, 2]);
    // The request-changes verdict is still the one at the head; nothing approved it.
    expect(s.rounds).toHaveLength(1);
    expect(s.rounds[0]).toMatchObject({ headSha: 'H1', verdict: 'request_changes' });
    expect(s.d.approvedHeads).toEqual([]);
  });

  test('a fix that reports success without moving the head is not delivery: no re-review, no approval (#3754 proof)', () => {
    const { s, fix } = requested();
    const r = s.fixEnded(fix, { outcome: 'success', localHeadSha: 'H1', commitCount: 0 });
    expectApplied(r, 'AWAITING_PUSH');
    expect(r.result === 'applied' && r.decision.evidence.proof).toEqual({ holds: false, reason: 'head_not_advanced' });
    expect(s.view.attempts.find((a) => a.id === fix)!.outcome).toBe('unproven');
    expect(s.rounds).toHaveLength(1);
    expect(s.d.approvedHeads).toEqual([]);
  });

  test('a person merging on GitHub over the open verdict is recorded as merged over it', () => {
    const { s } = requested();
    const r = s.submit({ type: 'PrMerged', actor: 'webhook', live: mergedLive('H1') });
    expectApplied(r, 'MERGED');
    expect(r.result === 'applied' && r.decision.evidence.reviewClass).toBe('merged_over_verdict');
  });

  test.todo('AC-19: a repair that ends with zero diff and no evidence keeps its findings open and its attempt reads "no change"');
  test.todo('AC-18: open findings on a mission PR survive a coordination owner replacement and a branch refresh');
});

describe('#4679: a second push before re-review', () => {
  const fixedThenPushedAgain = () => {
    const s = new Scenario().open();
    s.ownerPushed('H1');
    s.verdict('request_changes');
    const fix = s.startFix();
    expectApplied(s.fixEnded(fix, { localHeadSha: 'H2', commitCount: 1, live: live('H2'), proof: { liveContainsLocal: true } }), 'AWAITING_REVIEW');
    const fixRound = s.latestRound;
    expectApplied(s.push('H3'), 'AWAITING_REVIEW');
    return { s, fixRound };
  };

  test('the fix push starts a round; the second push supersedes it with a round at the newer head', () => {
    const { s, fixRound } = fixedThenPushedAgain();
    expect(s.rounds.find((r) => r.id === fixRound.id)).toMatchObject({ round: 2, headSha: 'H2', status: 'superseded' });
    expect(s.latestRound).toMatchObject({ round: 3, headSha: 'H3', kind: 'delta', status: 'queued' });
    expect(s.d.currentHeadSha).toBe('H3');
  });

  test('the fix landed, so the delivery no longer reads as changes requested', () => {
    const { s } = fixedThenPushedAgain();
    expect(s.state).toBe('AWAITING_REVIEW');
    expect(deriveDeliveryView({ view: s.view })!.state).toBe('AWAITING_REVIEW');
  });

  test('a late approval of the superseded head is kept for audit but approves nothing', () => {
    const { s, fixRound } = fixedThenPushedAgain();
    const v = s.d.version;
    expectNotApplied(s.verdict('approve', fixRound.id, 'H2'), 'stale', 'round_superseded');
    expect(s.rounds.find((r) => r.id === fixRound.id)!.verdict).toBe('approve');
    expect(s.d).toMatchObject({ state: 'AWAITING_REVIEW', approvedHeads: [], version: v });
    expect(s.k.effects(s.d.id, 'post_review').map((e) => e.payload.event)).toEqual(['REQUEST_CHANGES']);
  });

  test('approval binds only the reviewed head: H3 approved, H2 never, and a later push is unapproved', () => {
    const { s } = fixedThenPushedAgain();
    expectApplied(s.verdict('approve'), 'APPROVED');
    expect(s.d.approvedHeads).toEqual(['H3']);
    expect(s.k.effects(s.d.id, 'post_review').at(-1)!.payload).toMatchObject({ commitId: 'H3', event: 'APPROVE' });
    expectNotApplied(s.land('H2'), 'stale', 'head_moved');
    expectApplied(s.push('H4'), 'AWAITING_REVIEW');
    expect(s.d.approvedHeads).not.toContain('H4');
  });

  test.todo('AC-17: a fix push that touches one finding marks it addressed and a migration-only push leaves the other open; approval needs a review verifying the addressed one');
});
