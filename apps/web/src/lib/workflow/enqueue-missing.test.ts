/**
 * §11 permitted operation 2: the effects each state owes, as a pure function of
 * (state, attributes, existing effects). A sweep inserts what is missing under
 * the effect's own dedupe key, so an effect that exists in any status is never
 * owed twice (task ddcbe113).
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { enqueueMissingEffects, enqueueEffectSql, existingEffectsSql } from './enqueue-missing';
import type { AttemptSnapshot, DeliverySnapshot, KernelView, RoundSnapshot } from './types';

const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
  state: 'WORKING', stateReason: null, version: 5, currentHeadSha: 'H1', currentRound: 1, maxRounds: 3,
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
const V = (d: DeliverySnapshot, rounds: RoundSnapshot[] = [], attempts: AttemptSnapshot[] = []): KernelView => ({ delivery: d, rounds, attempts });
const none = new Set<string>();
const rc = R({ status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes' });

describe('enqueueMissingEffects (§11 op 2)', () => {
  test('CHANGES_REQUESTED owes a dispatch_fix for the current round, keyed as the reducer keys it', () => {
    expect(enqueueMissingEffects(V(D({ state: 'CHANGES_REQUESTED' }), [rc]), none)).toEqual([
      { kind: 'dispatch_fix', dedupeKey: 'dispatch_fix:d1:r1:1', payload: { roundId: 'r1', round: 1, headSha: 'H1', attemptNo: 1 } },
    ]);
    // After a failed attempt the next one is owed.
    expect(enqueueMissingEffects(V(D({ state: 'CHANGES_REQUESTED' }), [rc], [A({ status: 'ended', outcome: 'failed' })]), none)[0].dedupeKey).toBe('dispatch_fix:d1:r1:2');
  });

  test('nothing is owed when the effect exists in any status, or a fix is already in flight', () => {
    expect(enqueueMissingEffects(V(D({ state: 'CHANGES_REQUESTED' }), [rc]), new Set(['dispatch_fix:d1:r1:1']))).toEqual([]);
    expect(enqueueMissingEffects(V(D({ state: 'CHANGES_REQUESTED' }), [rc], [A({ status: 'running' })]), none)).toEqual([]);
  });

  test('a CHANGES_REQUESTED whose round is not at the current head owes nothing here: that is a head fact, not a fix', () => {
    expect(enqueueMissingEffects(V(D({ state: 'CHANGES_REQUESTED', currentHeadSha: 'H2' }), [rc]), none)).toEqual([]);
  });

  test('AWAITING_REVIEW owes a dispatch_review for its queued round at the current head', () => {
    const decided = R({ id: 'r1', round: 1, status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes' });
    const open = R({ id: 'r2', round: 2, headSha: 'H2', kind: 'delta' });
    expect(enqueueMissingEffects(V(D({ state: 'AWAITING_REVIEW', currentHeadSha: 'H2', currentRound: 2 }), [decided, open]), none)).toEqual([
      { kind: 'dispatch_review', dedupeKey: 'dispatch_review:d1:2', payload: { roundId: 'r2', round: 2, headSha: 'H2', kind: 'delta', priorRound: 1, scope: null } },
    ]);
    expect(enqueueMissingEffects(V(D({ state: 'AWAITING_REVIEW', currentHeadSha: 'H2', currentRound: 2 }), [decided, open]), new Set(['dispatch_review:d1:2']))).toEqual([]);
    // A round already being reviewed has its reviewer.
    expect(enqueueMissingEffects(V(D({ state: 'AWAITING_REVIEW' }), [R({ status: 'reviewing' })]), none)).toEqual([]);
  });

  test('AWAITING_PUSH owes a push_recovery only when none was ever enqueued for the local head', () => {
    const v = V(D({ state: 'AWAITING_PUSH', pushPendingLocalHead: 'L2' }));
    const [e] = enqueueMissingEffects(v, none);
    expect(e).toMatchObject({ kind: 'push_recovery', dedupeKey: 'push_recovery:d1:L2:1', payload: { localHeadSha: 'L2', try: 1 } });
    expect(enqueueMissingEffects(v, new Set(['push_recovery:d1:L2:3']))).toEqual([]);
  });

  test('67d34094: a dead push_recovery chain does not block its own re-enqueue: the last try is owed, once', () => {
    const v = V(D({ state: 'AWAITING_PUSH', pushPendingLocalHead: 'L2' }));
    const keys = new Set(['push_recovery:d1:L2:1', 'push_recovery:d1:L2:2']);
    // A chain still running (or finished) holds.
    expect(enqueueMissingEffects(v, keys, new Map([['push_recovery:d1:L2:1', 'done'], ['push_recovery:d1:L2:2', 'pending']]))).toEqual([]);
    // Every try dead: the final try is owed, which is T22 when the head has not moved.
    const deadAll = new Map([['push_recovery:d1:L2:1', 'dead'], ['push_recovery:d1:L2:2', 'dead']]);
    expect(enqueueMissingEffects(v, keys, deadAll)).toEqual([
      { kind: 'push_recovery', dedupeKey: 'push_recovery:d1:L2:final', payload: { localHeadSha: 'L2', try: 3, maxTries: 3 } },
    ]);
    // …and only once: the final key, dead or not, is held by its dedupe key.
    const withFinal = new Set([...keys, 'push_recovery:d1:L2:final']);
    expect(enqueueMissingEffects(v, withFinal, new Map([...deadAll, ['push_recovery:d1:L2:final', 'dead']]))).toEqual([]);
  });

  test('9e27996d: a chain with no try left to run (all done, the delivery still AWAITING_PUSH) owes the final try', () => {
    const v = V(D({ state: 'AWAITING_PUSH', pushPendingLocalHead: 'L2' }));
    const keys = new Set(['push_recovery:d1:L2:1', 'push_recovery:d1:L2:2', 'push_recovery:d1:L2:head:H2']);
    const allDone = new Map([...keys].map((k) => [k, 'done']));
    expect(enqueueMissingEffects(v, keys, allDone)).toEqual([
      { kind: 'push_recovery', dedupeKey: 'push_recovery:d1:L2:final', payload: { localHeadSha: 'L2', try: 3, maxTries: 3 } },
    ]);
    // A restarted chain's try still pending owns the move.
    const restarted = new Set([...keys, 'push_recovery:d1:L2:head:H2:2']);
    expect(enqueueMissingEffects(v, restarted, new Map([...allDone, ['push_recovery:d1:L2:head:H2:2', 'pending']]))).toEqual([]);
  });

  test('abe42d1b: a live chain under another local head is not doubled by one under the attempt’s reported head', () => {
    const v = V(D({ state: 'AWAITING_PUSH', boundAttemptId: 'a1' }), [], [A({ status: 'ended', outcome: 'unproven', reportedShas: ['H2'] })]);
    const none = new Set(['push_recovery:d1:none:1']);
    expect(enqueueMissingEffects(v, none, new Map([['push_recovery:d1:none:1', 'pending']]))).toEqual([]);
    // Once that chain has nothing left to run, the floor owes one under the head it reads.
    expect(enqueueMissingEffects(v, none, new Map([['push_recovery:d1:none:1', 'done']]))[0]).toMatchObject({ dedupeKey: 'push_recovery:d1:H2:1' });
  });

  test('67d34094: LANDING with no live merge_call or verify_merge owes one read-back per version', () => {
    const v = V(D({ state: 'LANDING', approvedHeads: ['H1'], version: 7 }));
    const mergeKey = 'merge_call:d1:H1:v6';
    // The merge call is still running its retries: nothing owed.
    expect(enqueueMissingEffects(v, new Set([mergeKey]), new Map([[mergeKey, 'pending']]))).toEqual([]);
    expect(enqueueMissingEffects(v, new Set([mergeKey]), new Map([[mergeKey, 'delivering']]))).toEqual([]);
    // Dead (or done with the delivery still LANDING): a verify_merge re-reads the PR.
    const owed = [{ kind: 'verify_merge', dedupeKey: 'verify_merge:d1:H1:floor:v7', payload: { headSha: 'H1', outcome: 'indeterminate', landingVersion: 7, source: 'floor' } }];
    expect(enqueueMissingEffects(v, new Set([mergeKey]), new Map([[mergeKey, 'dead']]))).toEqual(owed);
    expect(enqueueMissingEffects(v, new Set([mergeKey]), new Map([[mergeKey, 'done']]))).toEqual(owed);
    // A live read-back holds; the floor's own key is never owed twice.
    const vk = 'verify_merge:d1:H1:x:indeterminate';
    expect(enqueueMissingEffects(v, new Set([mergeKey, vk]), new Map([[mergeKey, 'done'], [vk, 'pending']]))).toEqual([]);
    expect(enqueueMissingEffects(v, new Set([mergeKey, owed[0].dedupeKey]), new Map([[mergeKey, 'dead'], [owed[0].dedupeKey, 'dead']]))).toEqual([]);
  });

  test('states that owe nothing to the floor, and terminal states, return nothing', () => {
    for (const state of ['WORKING', 'FIXING', 'APPROVED', 'ESCALATED', 'MERGED', 'CLOSED_UNMERGED'] as const) {
      expect(enqueueMissingEffects(V(D({ state }), [rc]), none)).toEqual([]);
    }
  });
});

describe('SQL', () => {
  const dialect = new PgDialect();
  test('enqueue is pinned to the version read and keyed on the dedupe key', () => {
    const q = dialect.sqlToQuery(enqueueEffectSql('d1', 5, { kind: 'dispatch_fix', dedupeKey: 'k', payload: { a: 1 } }));
    expect(q.sql).toContain('ON CONFLICT (dedupe_key) DO NOTHING');
    expect(q.sql).toContain('d.version = $');
    expect(q.params).toEqual(['dispatch_fix', 'k', '{"a":1}', 0, 'd1', 5]);
  });
  test('existing effects are read per delivery', () => {
    const q = dialect.sqlToQuery(existingEffectsSql('d1'));
    expect(q.sql).toContain('FROM workflow_effects WHERE delivery_id = $1::uuid');
    expect(q.params).toEqual(['d1']);
  });
});
