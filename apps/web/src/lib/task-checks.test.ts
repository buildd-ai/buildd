/**
 * The task page's checks list (docs/specs/task-page.md): rows from delivery
 * facts only, current round first, repairs attached to what caused them.
 */
import { describe, expect, test } from 'bun:test';
import { deriveTaskChecks, reviewDetailOf, taskSubjectOf, type ChecksInput, type ReviewFindings } from './task-checks';
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

  test('e07ee9cf: a refresh parked in the landing lane is queued behind the PR landing first, not running', () => {
    const approved = R({ status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' });
    const refresh = A({ id: 'm1', family: 'conflict', mode: 'mechanical', triggerReason: 'behind', boundHeadSha: 'HEADB000', taskId: null, status: 'queued' });
    const c = deriveTaskChecks(V({ state: 'REPAIRING', stateReason: 'behind', rounds: [approved], ledger: [refresh], approvedCurrentHead: true, laneWait: { behindPr: 5657, position: 2 } }));
    expect(row(c, 'merge')).toMatchObject({ state: 'pending', result: 'Queued to land behind #5657, position 2', repair: null });
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

  test('a superseded PR passes Merge: Merged in #N from the supersession record, never a closed ✕', () => {
    const superseded = V({ state: 'SUPERSEDED', prState: 'closed', supersededBy: { prNumber: 5408, url: 'https://github.com/o/r/pull/5408', reason: 'r' } });
    expect(row(deriveTaskChecks(superseded), 'merge')).toMatchObject({ state: 'passed', result: 'Merged in #5408' });
    // Copy catalog: without the merging PR's number it is still a merge elsewhere, never Landed.
    expect(row(deriveTaskChecks(V({ state: 'SUPERSEDED', prState: 'closed' })), 'merge')).toMatchObject({ state: 'passed', result: 'Merged in another PR' });
  });

  test('AC-5: round 2 approved is current; round 1 and its fix are history', () => {
    const r1 = R({ id: 'r1', round: 1, headSha: 'HEADA000', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes', reviewerTaskId: 'rev1' });
    const r2 = R({ id: 'r2', round: 2, headSha: 'HEADB000', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', reviewerTaskId: 'rev2' });
    const fix = A({ status: 'ended', outcome: 'delivered' });
    const c = deriveTaskChecks(V({ state: 'APPROVED', rounds: [r1, r2], ledger: [fix], approvedCurrentHead: true }));
    expect(row(c, 'review')).toMatchObject({ result: 'Approved · round 2', reviewTaskId: 'rev2' });
    expect(c.history).toEqual([
      { round: 1, headSha: 'HEADA00', result: 'Changes requested', state: 'failed', reviewTaskId: 'rev1', repairs: [{ label: 'Review fix 1 of 3', status: 'pushed', taskId: 'fix1' }] },
    ]);
  });

  test('AC-19 (workflow-kernel-library.md §5): a repair that changed nothing reads "no change", never "completed"', () => {
    const r1 = R({ id: 'r1', round: 1, headSha: 'HEADA000', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes', reviewerTaskId: 'rev1' });
    for (const outcome of ['noop', 'unproven'] as const) {
      const c = deriveTaskChecks(V({ state: 'CHANGES_REQUESTED', headSha: 'HEADA000', rounds: [r1], ledger: [A({ status: 'ended', outcome })] }));
      expect(row(c, 'review')?.repair).toMatchObject({ label: 'Review fix 1 of 3', status: 'no_change' });
    }
  });

  // workflow-kernel-library.md §7: a repair reads its phase from attempt facts.
  describe('repair phase (§7)', () => {
    const r1 = R({ id: 'r1', round: 1, headSha: 'HEADA000', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes' });
    test('a review fix whose commits have not reached GitHub: awaiting push', () => {
      const c = deriveTaskChecks(V({ state: 'AWAITING_PUSH', headSha: 'HEADA000', rounds: [r1], ledger: [A({ status: 'ended', outcome: 'unproven', reportedShas: ['LOCAL1'] })] }));
      expect(row(c, 'review')?.repair).toMatchObject({ label: 'Review fix 1 of 3', status: 'awaiting_push' });
    });
    test('a review fix that pushed the head now awaiting its round: awaiting review, on the current row', () => {
      const r2 = R({ id: 'r2', round: 2, headSha: 'HEADB000', status: 'queued' });
      const c = deriveTaskChecks(V({ prState: 'ci_passed', rounds: [r1, r2], ledger: [A({ status: 'ended', outcome: 'delivered', pushedHeadSha: 'HEADB000' })] }));
      expect(row(c, 'review')).toMatchObject({ result: 'Awaiting review · round 2', repair: { label: 'Review fix 1 of 3', status: 'awaiting_review', taskId: 'fix1' } });
    });
    test('a CI fix that pushed the head CI is now running on: pushed and testing', () => {
      const fix = A({ id: 'c1', family: 'ci', triggerReason: 'ci', boundHeadSha: 'HEADA000', taskId: 'cifix', status: 'ended', outcome: 'delivered', pushedHeadSha: 'HEADB000' });
      const c = deriveTaskChecks(V({ state: 'AWAITING_REVIEW', prState: 'awaiting_ci', ledger: [fix] }));
      expect(row(c, 'tests')).toMatchObject({ state: 'running', result: 'Checking', repair: { label: 'CI fix 1 of 3', status: 'pushed_testing', taskId: 'cifix' } });
    });
    test('queued and running repairs keep those words', () => {
      expect(row(deriveTaskChecks(V({ state: 'CHANGES_REQUESTED', headSha: 'HEADA000', rounds: [r1], ledger: [A()] })), 'review')?.repair?.status).toBe('queued');
      expect(row(deriveTaskChecks(V({ state: 'FIXING', headSha: 'HEADA000', rounds: [r1], ledger: [A({ status: 'running' })] })), 'review')?.repair?.status).toBe('running');
    });
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

// What an opened Code review row says (task-page spec §Code review detail).
// A self-reference is never detail on its own; old findings never ride on a
// newer head; missing output never reads as an approval.
describe('reviewDetailOf', () => {
  const reviewRowOf = (v: ChecksInput) => row(deriveTaskChecks(v), 'review')!;
  const F = (o: Record<string, ReviewFindings> = {}) => new Map(Object.entries(o));
  const opts = (o: Partial<Parameters<typeof reviewDetailOf>[1]> = {}) => ({ findings: F(), currentTaskId: 'rev1', ...o });

  test('self, queued: says the review is queued with no findings yet, bound to round and head, no self link', () => {
    const r = reviewRowOf(V({ rounds: [R({ status: 'queued' })] }));
    const d = reviewDetailOf(r, opts({ findings: F({ rev1: { prose: null, verdict: null, status: 'pending' } }) }));
    expect(d).toEqual({ kind: 'queued', text: 'Review queued · no findings yet', round: { round: 1, headSha: 'HEADB00', carried: false }, linkTaskId: null });
  });

  test('self, running: the reviewer task being claimed makes it in progress even while the round is queued', () => {
    const r = reviewRowOf(V({ rounds: [R({ status: 'queued' })] }));
    const d = reviewDetailOf(r, opts({ findings: F({ rev1: { prose: null, verdict: null, status: 'in_progress' } }) }));
    expect(d).toMatchObject({ kind: 'running', text: 'Review in progress · no findings yet', linkTaskId: null });
    expect(reviewDetailOf(reviewRowOf(V({ rounds: [R({ status: 'reviewing' })] })), opts())).toMatchObject({ kind: 'running' });
  });

  test('self, completed with findings: the prose, round and head, and no link back to this page', () => {
    const r = reviewRowOf(V({ state: 'APPROVED', rounds: [R({ status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' })], approvedCurrentHead: true }));
    const d = reviewDetailOf(r, opts({ findings: F({ rev1: { prose: 'No blocking findings.', verdict: 'approve', status: 'completed' } }) }));
    expect(d).toEqual({ kind: 'findings', prose: 'No blocking findings.', round: { round: 1, headSha: 'HEADB00', carried: false }, linkTaskId: null });
  });

  test('another task\'s review keeps its link', () => {
    const r = reviewRowOf(V({ rounds: [R({ status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes' })] }));
    const d = reviewDetailOf(r, opts({ currentTaskId: 'deliverable', findings: F({ rev1: { prose: 'Fix the label.', verdict: 'request-changes', status: 'completed' } }) }));
    expect(d).toMatchObject({ kind: 'findings', prose: 'Fix the label.', linkTaskId: 'rev1' });
  });

  test('a decided round whose reviewer left no output says so, and never reads as approval', () => {
    const r = reviewRowOf(V({ state: 'APPROVED', rounds: [R({ status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' })] }));
    const d = reviewDetailOf(r, opts({ findings: F({ rev1: { prose: null, verdict: null, status: 'completed' } }) }));
    expect(d).toMatchObject({ kind: 'no-output', text: 'The review finished without written findings' });
    expect(JSON.stringify(d)).not.toMatch(/approv/i);
    // No record at all for the reviewer task reads the same, not as loading.
    expect(reviewDetailOf(r, opts())).toMatchObject({ kind: 'no-output' });
  });

  test('a failed retrieval is explicit and offers a retry, even when nothing was read', () => {
    const r = reviewRowOf(V({ rounds: [R({ status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' })] }));
    expect(reviewDetailOf(r, opts({ findingsUnavailable: true }))).toMatchObject({ kind: 'unavailable', text: 'Couldn’t load the review’s findings' });
  });

  test('a failed review run says it failed before a verdict', () => {
    const r = reviewRowOf(V({ rounds: [R({ status: 'failed' })] }));
    expect(reviewDetailOf(r, opts())).toMatchObject({ kind: 'run-failed', text: 'The review run ended before giving a verdict' });
  });

  test('stale round: an approval on an older head is history, so the current row opens to nothing', () => {
    const old = R({ status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', headSha: 'HEADA000' });
    const r = reviewRowOf(V({ rounds: [old] }));
    expect(r.result).toBe('Awaiting review');
    expect(reviewDetailOf(r, opts({ currentTaskId: 'deliverable', findings: F({ rev1: { prose: 'Old findings on head A.', verdict: 'approve', status: 'completed' } }) }))).toBeNull();
  });

  test('a carried approval says which head its findings were written on', () => {
    const old = R({ status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', headSha: 'HEADA000' });
    const r = reviewRowOf(V({ state: 'APPROVED', rounds: [old], approvedCurrentHead: true }));
    const d = reviewDetailOf(r, opts({ currentTaskId: 'deliverable', findings: F({ rev1: { prose: 'Fine.', verdict: 'approve', status: 'completed' } }) }));
    expect(d).toMatchObject({ kind: 'findings', round: { round: 1, headSha: 'HEADA00', carried: true }, linkTaskId: 'rev1' });
  });

  test('policy-skipped or never-queued review has nothing to open', () => {
    expect(reviewDetailOf(reviewRowOf(V({ approvalBasis: 'policy' })), opts())).toBeNull();
    expect(reviewDetailOf(reviewRowOf(V()), opts())).toBeNull();
  });
});
