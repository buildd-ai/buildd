/**
 * The task page's checks list (docs/specs/task-page.md): rows from delivery
 * facts only, current round first, repairs attached to what caused them.
 */
import { describe, expect, test } from 'bun:test';
import { deriveTaskChecks, taskSubjectOf, type ChecksInput } from './task-checks';
import type { DeliveryView } from './workflow/projections';

type RoundSnapshot = DeliveryView['rounds'][number];
type AttemptSnapshot = DeliveryView['ledger'][number];

const R = (o: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  id: 'r1', round: 1, headSha: 'HEADB000', kind: 'full', status: 'queued', verdict: null, effectiveVerdict: null, failureCount: 0, reviewerTaskId: 'rev1', ...o,
});
const A = (o: Partial<AttemptSnapshot> = {}): AttemptSnapshot => ({
  id: 'a1', family: 'review_fix', attemptNo: 1, mode: 'agent', boundHeadSha: 'HEADA000', triggerReason: 'r1', taskId: 'fix1',
  status: 'queued', outcome: null, maxAttempts: 3, reportedShas: [], ...o,
});
const V = (o: Partial<ChecksInput> = {}): ChecksInput => ({
  state: 'AWAITING_REVIEW', stateReason: null, prNumber: 4413, headSha: 'HEADB000', prState: 'awaiting_ci',
  rounds: [], ledger: [], approvedCurrentHead: false, approvalBasis: null, ...o,
});
const row = (c: ReturnType<typeof deriveTaskChecks>, key: string) => c.current.find(r => r.key === key);

describe('deriveTaskChecks', () => {
  test('the screenshot case: approved review, parent awaiting merge, CI green', () => {
    const approved = R({ status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' });
    const c = deriveTaskChecks(V({ state: 'APPROVED', prState: 'ci_passed', rounds: [approved], approvedCurrentHead: true, approvalBasis: 'verdict' }));
    expect(row(c, 'review')).toMatchObject({ state: 'passed', result: 'Approved · round 1', reviewTaskId: 'rev1' });
    expect(row(c, 'tests')).toMatchObject({ state: 'passed', result: 'Passed' });
    expect(row(c, 'merge')).toMatchObject({ state: 'pending', result: 'Awaiting merge' });
    expect(c.current.map(r => r.result).join(' ')).not.toMatch(/Merged|Repair/);
  });

  test('AC-2: a branch refresh is Updating branch on Merge, with no repair attached', () => {
    const approved = R({ status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' });
    const refresh = A({ id: 'm1', family: 'conflict', mode: 'mechanical', triggerReason: 'behind', boundHeadSha: 'HEADB000', taskId: null, status: 'running' });
    const c = deriveTaskChecks(V({ state: 'REPAIRING', stateReason: 'behind', rounds: [approved], ledger: [refresh], approvedCurrentHead: true }));
    expect(row(c, 'merge')).toMatchObject({ state: 'running', result: 'Updating branch', repair: null });
    expect(row(c, 'review')?.repair).toBeNull();
  });

  test('AC-3: CI red with an agent fix running: Tests failed, repair Fixing', () => {
    const fix = A({ id: 'c1', family: 'ci', triggerReason: 'ci', boundHeadSha: 'HEADB000', taskId: 'cifix', status: 'running' });
    const c = deriveTaskChecks(V({ state: 'REPAIRING', stateReason: 'ci', prState: 'ci_failed', ledger: [fix] }));
    expect(row(c, 'tests')).toMatchObject({ state: 'failed', result: 'Failed' });
    expect(row(c, 'tests')?.repair).toEqual({ label: 'CI fix 1 of 3', status: 'running', taskId: 'cifix' });
  });

  test('AC-4: merged reads Merged; approved never does', () => {
    expect(row(deriveTaskChecks(V({ state: 'MERGED', prState: 'merged' })), 'merge')).toMatchObject({ state: 'passed', result: 'Merged' });
    expect(row(deriveTaskChecks(V({ state: 'APPROVED', approvedCurrentHead: true })), 'merge')?.result).toBe('Awaiting merge');
  });

  test('AC-5: round 2 approved is current; round 1 and its fix are history', () => {
    const r1 = R({ id: 'r1', round: 1, headSha: 'HEADA000', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes', reviewerTaskId: 'rev1' });
    const r2 = R({ id: 'r2', round: 2, headSha: 'HEADB000', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', reviewerTaskId: 'rev2' });
    const fix = A({ status: 'ended', outcome: 'delivered' });
    const c = deriveTaskChecks(V({ state: 'APPROVED', rounds: [r1, r2], ledger: [fix], approvedCurrentHead: true }));
    expect(row(c, 'review')).toMatchObject({ result: 'Approved · round 2', reviewTaskId: 'rev2' });
    expect(c.history).toEqual([
      { round: 1, headSha: 'HEADA00', result: 'Changes requested', state: 'failed', reviewTaskId: 'rev1', repairs: [{ label: 'Review fix 1 of 3', status: 'completed', taskId: 'fix1' }] },
    ]);
  });

  test('AC-6: an approval of an older head is history, not the current review', () => {
    const old = R({ headSha: 'HEADA000', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' });
    const c = deriveTaskChecks(V({ state: 'AWAITING_REVIEW', rounds: [old], approvedCurrentHead: false }));
    expect(row(c, 'review')).toMatchObject({ state: 'pending', result: 'Awaiting review' });
    expect(c.history[0]).toMatchObject({ round: 1, result: 'Approved' });
  });

  test('an approval carried to a refreshed head stays current and says so', () => {
    const old = R({ headSha: 'HEADA000', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' });
    const c = deriveTaskChecks(V({ state: 'APPROVED', rounds: [old], approvedCurrentHead: true }));
    expect(row(c, 'review')).toMatchObject({ state: 'passed', result: 'Approved · round 1 · still valid after a branch update' });
    expect(c.history).toEqual([]);
  });

  test('review in flight reads In review; a queued round Awaiting review', () => {
    expect(row(deriveTaskChecks(V({ rounds: [R({ status: 'reviewing' })] })), 'review')?.result).toBe('In review · round 1');
    expect(row(deriveTaskChecks(V({ rounds: [R()] })), 'review')?.result).toBe('Awaiting review · round 1');
  });

  test('a policy approval draws no invented review', () => {
    const c = deriveTaskChecks(V({ state: 'APPROVED', approvalBasis: 'policy', approvedCurrentHead: true }));
    expect(row(c, 'review')).toMatchObject({ state: 'skipped', result: 'Not required by policy' });
  });

  test('a review round is never counted as a repair', () => {
    const c = deriveTaskChecks(V({ rounds: [R({ status: 'reviewing' })] }));
    expect(c.current.every(r => r.repair === null)).toBe(true);
    expect(c.current.map(r => r.result).join(' ')).not.toMatch(/repair/i);
  });

  test('a conflict with an agent fix: Merge conflict, repair attached', () => {
    const fix = A({ id: 'k1', family: 'conflict', triggerReason: 'conflict', boundHeadSha: 'HEADB000', taskId: 'cf', status: 'queued' });
    const c = deriveTaskChecks(V({ state: 'REPAIRING', stateReason: 'conflict', prState: 'conflict', ledger: [fix] }));
    expect(row(c, 'merge')).toMatchObject({ state: 'failed', result: 'Conflict with base', repair: { label: 'Conflict fix 1 of 3', status: 'queued', taskId: 'cf' } });
  });

  test('AC-10: no PR, no checks: nothing is invented', () => {
    expect(deriveTaskChecks(V({ state: 'FAILED', prNumber: null, prState: null }))).toEqual({ current: [], history: [] });
  });

  test('closed without merging', () => {
    expect(row(deriveTaskChecks(V({ state: 'CLOSED_UNMERGED', prState: 'closed' })), 'merge')).toMatchObject({ state: 'closed', result: 'Closed without merging' });
  });
});

describe('taskSubjectOf', () => {
  const view = { ownerTaskId: 'own', history: [{ taskId: 'own', role: 'owner', status: 'assigned', superseded: false }, { taskId: 'rev', role: 'review', status: 'completed', superseded: false }, { taskId: 'fx', role: 'fix', status: 'running', superseded: false }] };
  test('the delivery says which run this is', () => {
    expect(taskSubjectOf({ taskId: 'own', view, context: null, parentTaskId: null })).toEqual({ kind: 'deliverable', deliverableTaskId: 'own' });
    expect(taskSubjectOf({ taskId: 'rev', view, context: null, parentTaskId: null })).toEqual({ kind: 'review', deliverableTaskId: 'own' });
    expect(taskSubjectOf({ taskId: 'fx', view, context: null, parentTaskId: null })).toEqual({ kind: 'fix', deliverableTaskId: 'own' });
  });
  test('legacy: context.reviewerFor marks a review; retry columns a fix', () => {
    expect(taskSubjectOf({ taskId: 'x', view: null, context: { reviewerFor: 'p' }, parentTaskId: 'p' })).toEqual({ kind: 'review', deliverableTaskId: 'p' });
    expect(taskSubjectOf({ taskId: 'x', view: null, context: null, parentTaskId: 'p', retryOf: true })).toEqual({ kind: 'fix', deliverableTaskId: 'p' });
    expect(taskSubjectOf({ taskId: 'x', view: null, context: null, parentTaskId: 'p' })).toEqual({ kind: 'deliverable', deliverableTaskId: 'x' });
  });
});
