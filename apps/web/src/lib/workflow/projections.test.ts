/**
 * DeliveryView (docs/specs/workflow-state-kernel.md §4, §17.5): one owner of
 * the next move per state, recoverable blockers stay platform-owned with
 * their evidence, replacement chains read current (S35), and a conflicted PR
 * with an existing remediation offers Run/Repair instead of a second fix (S37).
 */
import { describe, expect, test } from 'bun:test';
import { attemptFailureCounts, attemptLine, deriveDeliveryView, ownerOfNextMove, type DeliveryViewInput } from './projections';

describe('attemptLine (§5.7 rule 4)', () => {
  test('family-labelled, 1-based, only the families the ledger has', () => {
    expect(attemptLine({ ci: { n: 1, m: 3 }, review_fix: { n: 2, m: 3 } })).toBe('CI 1 of 3 · review 2 of 3');
    expect(attemptLine({ conflict: { n: 1, m: 2 } })).toBe('conflict 1 of 2');
    expect(attemptLine({})).toBeNull();
  });
});
import { DELIVERY_STATES, type AttemptSnapshot, type DeliverySnapshot, type DeliveryState, type KernelView, type RoundSnapshot } from './types';

const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
  state: 'WORKING', stateReason: null, version: 5, currentHeadSha: 'H1abcdef', currentRound: 0, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const R = (o: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  id: 'r1', round: 1, headSha: 'H1abcdef', kind: 'full', status: 'queued', verdict: null, effectiveVerdict: null, failureCount: 0, ...o,
});
const A = (o: Partial<AttemptSnapshot> = {}): AttemptSnapshot => ({
  id: 'a1', family: 'review_fix', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1abcdef', triggerReason: 'r1', taskId: 'ft1',
  status: 'queued', outcome: null, maxAttempts: 3, reportedShas: [], ...o,
});
const V = (d: DeliverySnapshot, rounds: RoundSnapshot[] = [], attempts: AttemptSnapshot[] = []): KernelView => ({ delivery: d, rounds, attempts });
const view = (input: Partial<DeliveryViewInput> & { view: KernelView }) => deriveDeliveryView(input as DeliveryViewInput)!;

describe('owner of the next move (§4)', () => {
  test('every non-terminal state has exactly one owner; terminal states have none', () => {
    const terminal = new Set<DeliveryState>(['MERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED']);
    for (const s of DELIVERY_STATES) {
      const o = ownerOfNextMove(s);
      if (terminal.has(s)) expect(o).toBe('none');
      else expect(o).not.toBe('none');
    }
  });

  test('only ESCALATED is a person: needsYou never comes from a worker ending', () => {
    for (const s of DELIVERY_STATES) {
      const v = view({ view: V(D({ state: s })) });
      expect(v.needsYou).toBe(s === 'ESCALATED');
    }
  });

  test('AWAITING_PUSH is platform-owned and keeps its evidence', () => {
    const v = view({ view: V(D({ state: 'AWAITING_PUSH', currentHeadSha: 'abc1234deadbeef' })) });
    expect(v.owner).toBe('platform');
    expect(v.needsYou).toBe(false);
    expect(v.headline).toBe('Waiting for the fix to reach GitHub');
    expect(v.detail).toContain('abc1234');
  });

  test('an escalation carries the transition evidence, not generic copy', () => {
    const v = view({
      view: V(D({ state: 'ESCALATED', stateReason: 'review_escalated' })),
      lastTransition: { command: 'ReviewVerdictRecorded', fromState: 'AWAITING_REVIEW', toState: 'ESCALATED', evidence: { reason: 'touches the auth boundary' }, createdAt: '2026-10-06T00:00:00Z' },
    });
    expect(v.owner).toBe('human');
    expect(v.headline).toBe('The reviewer escalated this PR');
    expect(v.detail).toBe('touches the auth boundary');
  });

  test('a review round that is being reviewed reads Reviewing, a queued one Review queued', () => {
    expect(view({ view: V(D({ state: 'AWAITING_REVIEW', currentRound: 1 }), [R({ status: 'reviewing' })]) }).headline).toBe('Reviewing');
    expect(view({ view: V(D({ state: 'AWAITING_REVIEW', currentRound: 1 }), [R()]) }).headline).toBe('Review queued');
  });
});

describe('release composition', () => {
  test('APPROVED on a composition basis reads "Release composition verified"', () => {
    const v = view({ view: V(D({ state: 'APPROVED', approvalBasis: 'composition', compositionHeads: ['H1abcdef'] })) });
    expect(v.compositionVerified).toBe(true);
    expect(v.headline).toBe('Release composition verified');
    expect(v.owner).toBe('landing');
    expect(v.needsYou).toBe(false);
  });

  test('a composition head that is no longer current claims nothing', () => {
    const v = view({ view: V(D({ state: 'APPROVED', approvalBasis: 'composition', compositionHeads: ['OLD'] })) });
    expect(v.compositionVerified).toBe(false);
    expect(v.headline).toBe('Approved');
  });
});

describe('S35: replacement chains read current, not FAILED', () => {
  const tasks = [
    { taskId: 'fix1', role: 'fix', status: 'failed', createdAt: '2026-10-06T01:00:00Z' },
    { taskId: 'fix2', role: 'fix', status: 'in_progress', createdAt: '2026-10-06T02:00:00Z' },
    { taskId: 't1', role: 'owner', status: 'completed', createdAt: '2026-10-06T00:00:00Z' },
  ];
  const v = view({
    view: V(D({ state: 'FIXING', currentRound: 1, boundAttemptId: 'a2' }), [R({ status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes' })], [
      A({ id: 'a1', taskId: 'fix1', status: 'ended', outcome: 'failed' }),
      A({ id: 'a2', attemptNo: 2, taskId: 'fix2', status: 'running' }),
    ]),
    attemptTasks: tasks,
  });

  test('the delivery projects its current attempt', () => {
    expect(v.stage).toBe('fixing');
    expect(v.currentAttempt?.taskId).toBe('fix2');
    expect(v.attempts.review_fix).toEqual({ n: 2, m: 3 });
  });

  test('the failed predecessor stays auditable, marked superseded', () => {
    expect(v.history.find((h) => h.taskId === 'fix1')).toEqual({ taskId: 'fix1', role: 'fix', status: 'failed', superseded: true });
    expect(v.history.find((h) => h.taskId === 'fix2')?.superseded).toBe(false);
  });

  test('a failed attempt counts as a failure only when the delivery itself FAILED', () => {
    expect(attemptFailureCounts(v, 'fix1')).toBe(false);
    const merged = view({ view: V(D({ state: 'MERGED' })), attemptTasks: tasks });
    expect(attemptFailureCounts(merged, 'fix1')).toBe(false);
    const failed = view({ view: V(D({ state: 'FAILED', prNumber: null })), attemptTasks: [{ taskId: 't1', role: 'owner', status: 'failed', createdAt: '2026-10-06T00:00:00Z' }] });
    expect(attemptFailureCounts(failed, 't1')).toBe(true);
  });
});

describe('S37: conflict remediation already exists', () => {
  const conflicted = D({ state: 'AWAITING_REVIEW', mergeable: 'dirty', mergeableHeadSha: 'H1abcdef', currentRound: 1 });

  test('no remediation → "Merge conflict" with Resolve conflicts', () => {
    const v = view({ view: V(conflicted, [R()]) });
    expect(v.headline).toBe('Merge conflict');
    expect(v.cta).toEqual({ action: 'create_conflict_fix', label: 'Resolve conflicts' });
    expect(v.owner).toBe('platform');
    expect(v.needsYou).toBe(false);
  });

  test('a stalled pending remediation → "Conflict fix stalled" with Run fix on that task', () => {
    const v = view({ view: V(conflicted, [R()]), remediation: { taskId: 'cf1', family: 'conflict', taskStatus: 'pending', stalled: true, stallReason: 'pending for 40m with no runner claim' } });
    expect(v.headline).toBe('Conflict fix stalled');
    expect(v.detail).toBe('pending for 40m with no runner claim');
    expect(v.cta).toEqual({ action: 'repair_remediation', label: 'Run fix', taskId: 'cf1' });
    expect(v.owner).toBe('platform');
  });

  test('a stalled claimed remediation offers Repair', () => {
    const v = view({ view: V(conflicted, [R()]), remediation: { taskId: 'cf1', family: 'conflict', taskStatus: 'assigned', stalled: true } });
    expect(v.cta).toEqual({ action: 'repair_remediation', label: 'Repair', taskId: 'cf1' });
  });

  test('a live remediation is worker-owned with no CTA', () => {
    const v = view({ view: V(conflicted, [R()]), remediation: { taskId: 'cf1', family: 'conflict', taskStatus: 'in_progress', stalled: false } });
    expect(v.headline).toBe('Resolving conflicts');
    expect(v.owner).toBe('worker');
    expect(v.cta).toBeNull();
  });

  test('a conflict fact on an older head is not a conflict now', () => {
    const v = view({ view: V(D({ state: 'AWAITING_REVIEW', mergeable: 'dirty', mergeableHeadSha: 'OLD', currentRound: 1 }), [R()]) });
    expect(v.cta).toBeNull();
    expect(v.headline).toBe('Review queued');
  });

  test('a merged delivery never shows a conflict CTA', () => {
    const v = view({ view: V(D({ state: 'MERGED', mergeable: 'dirty', mergeableHeadSha: 'H1abcdef' })) });
    expect(v.cta).toBeNull();
    expect(v.headline).toBe('Merged');
  });
});
