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
