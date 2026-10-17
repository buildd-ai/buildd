/**
 * §7 (workflow-kernel-library.md): the review reading every surface prints
 * (round count, latest verdict, open findings) and the repair phase read from
 * attempt facts.
 */
import { describe, expect, test } from 'bun:test';
import { repairPhaseOf, REPAIR_PHASE_WORDS, reviewSummaryLine, reviewSummaryOf } from './delivery-summary';
import type { AttemptSnapshot, FindingSnapshot, RoundSnapshot } from './types';

const R = (o: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  id: 'r1', round: 1, headSha: 'H1', kind: 'full', status: 'decided', verdict: null, effectiveVerdict: null, failureCount: 0, ...o,
});
const F = (o: Partial<FindingSnapshot> = {}): FindingSnapshot => ({
  id: 'r1:0', originRoundId: 'r1', originRound: 1, originHeadSha: 'H1', ordinal: 0, path: 'a.ts', line: 1, title: 'x',
  required: true, status: 'open', lastRound: 1, addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null,
  deferredToTaskId: null, ...o,
});
const A = (o: Partial<AttemptSnapshot> = {}): AttemptSnapshot => ({
  id: 'a1', family: 'ci', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: null, taskId: 'fix1',
  status: 'queued', outcome: null, maxAttempts: 3, reportedShas: [], ...o,
});

describe('reviewSummaryOf (AC-24)', () => {
  test('null when the delivery has no review rounds', () => {
    expect(reviewSummaryOf({ rounds: [], findings: [] })).toBeNull();
  });

  test('two rounds: counts both, the latest decided verdict, every open finding', () => {
    const s = reviewSummaryOf({
      rounds: [
        R({ id: 'r2', round: 2, headSha: 'H2', effectiveVerdict: 'request_changes', verdict: 'request_changes' }),
        R({ id: 'r1', round: 1, effectiveVerdict: 'request_changes', verdict: 'request_changes' }),
      ],
      findings: [F(), F({ id: 'r1:1', status: 'addressed' }), F({ id: 'r1:2', status: 'resolved' }), F({ id: 'r2:0', required: false })],
    })!;
    expect(s).toEqual({ rounds: 2, latestRound: 2, latestVerdict: 'request_changes', inFlight: false, openFindings: 3, addressedFindings: 1, totalFindings: 4 });
    // c1d66a6a: one of them has a fix pushed since (addressed), waiting for a review to verify it.
    expect(reviewSummaryLine(s)).toBe('2 rounds · latest: changes requested · 3 open findings, 1 with a fix waiting for a re-review');
  });

  test('a round in flight is counted; the verdict is the newest decided one', () => {
    const s = reviewSummaryOf({ rounds: [R({ effectiveVerdict: 'request_changes' }), R({ id: 'r2', round: 2, status: 'reviewing' })], findings: [F({ status: 'resolved' })] })!;
    expect(s.rounds).toBe(2);
    expect(s.latestVerdict).toBe('request_changes');
    expect(s.inFlight).toBe(true);
    expect(s.reviewing).toBe(true);
    expect(reviewSummaryLine(s)).toBe('2 rounds · latest: changes requested · round 2 in review · no open findings');
  });

  test('a superseded round is not a round anyone reviewed', () => {
    const s = reviewSummaryOf({ rounds: [R({ effectiveVerdict: 'approve' }), R({ id: 'r2', round: 2, status: 'superseded' })] })!;
    expect(s.rounds).toBe(1);
    expect(reviewSummaryLine(s)).toBe('1 round · latest: approved · no open findings');
  });

  test('only queued: no verdict yet', () => {
    expect(reviewSummaryLine(reviewSummaryOf({ rounds: [R({ status: 'queued' })] })!)).toBe('1 round · round 1 queued · no open findings');
  });

  test('the effective verdict wins over the raw one', () => {
    expect(reviewSummaryOf({ rounds: [R({ verdict: 'approve', effectiveVerdict: 'request_changes' })] })!.latestVerdict).toBe('request_changes');
  });
});

describe('repairPhaseOf (§7: a repair from attempt facts)', () => {
  const d = (o: Partial<Parameters<typeof repairPhaseOf>[1]> = {}) => ({ state: 'REPAIRING' as const, headSha: 'H1', prState: 'ci_failed' as const, rounds: [] as RoundSnapshot[], ...o });

  test('queued and running read as themselves', () => {
    expect(repairPhaseOf(A({ status: 'queued' }), d())).toBe('queued');
    expect(repairPhaseOf(A({ status: 'running' }), d())).toBe('running');
  });

  test('ended with commits not yet on GitHub: awaiting push', () => {
    expect(repairPhaseOf(A({ status: 'ended', outcome: 'unproven', reportedShas: ['L1'] }), d({ state: 'AWAITING_PUSH' }))).toBe('awaiting_push');
  });

  test('pushed to the current head while CI runs: pushed and testing', () => {
    expect(repairPhaseOf(A({ status: 'ended', outcome: 'delivered', pushedHeadSha: 'H2' }), d({ state: 'AWAITING_REVIEW', headSha: 'H2', prState: 'awaiting_ci' }))).toBe('pushed_testing');
  });

  test('pushed, CI settled, a round queued on that head: awaiting review', () => {
    const rounds = [R({ id: 'r2', round: 2, headSha: 'H2', status: 'queued' })];
    expect(repairPhaseOf(A({ family: 'review_fix', status: 'ended', outcome: 'delivered', reportedShas: ['H2'] }), d({ state: 'AWAITING_REVIEW', headSha: 'H2', prState: 'ci_passed', rounds }))).toBe('awaiting_review');
  });

  test('a fix that changed nothing reads no change, never completed', () => {
    expect(repairPhaseOf(A({ status: 'ended', outcome: 'noop' }), d())).toBe('no_change');
    expect(repairPhaseOf(A({ status: 'ended', outcome: 'unproven' }), d({ state: 'REPAIRING' }))).toBe('no_change');
  });

  test('pushed and the head moved on since: pushed', () => {
    expect(repairPhaseOf(A({ status: 'ended', outcome: 'delivered', pushedHeadSha: 'H2' }), d({ state: 'APPROVED', headSha: 'H3', prState: 'ci_passed' }))).toBe('pushed');
  });

  test('failed and cancelled keep their meaning; every phase has words', () => {
    expect(repairPhaseOf(A({ status: 'ended', outcome: 'failed' }), d())).toBe('failed');
    expect(repairPhaseOf(A({ status: 'cancelled', outcome: 'noop' }), d())).toBe('cancelled');
    expect(repairPhaseOf(A({ status: 'skipped', outcome: 'noop' }), d())).toBe('cancelled');
    for (const w of Object.values(REPAIR_PHASE_WORDS)) expect(w).toMatch(/^[a-z]/);
  });
});
