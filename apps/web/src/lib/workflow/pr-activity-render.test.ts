/**
 * S26 (docs/specs/workflow-state-kernel.md §12.1) and Living Spec fa62b865 R-51 / AC-62: the PR
 * activity comment is a projection of the delivery, never an append log, and it is one state line
 * with "Open in Buildd": no timeline, findings, rounds line or escalation prose.
 */
import { describe, expect, test } from 'bun:test';
import { ownerParkedIn, parseRenderVersion, renderDeliveryActivity, renderVersionMarker, type ActivityTransition } from './pr-activity-render';
import { deriveDeliveryView } from './projections';
import type { AttemptSnapshot, DeliverySnapshot, FindingSnapshot, KernelView, RoundSnapshot } from './types';

const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
  state: 'WORKING', stateReason: null, version: 5, currentHeadSha: 'H2', currentRound: 2, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const rounds: RoundSnapshot[] = [
  { id: 'r1', round: 1, headSha: 'H1', kind: 'full', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes', failureCount: 0 },
  { id: 'r2', round: 2, headSha: 'H2', kind: 'delta', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes', failureCount: 0 },
];
const attempts: AttemptSnapshot[] = [
  { id: 'a1', family: 'review_fix', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: 'r1', taskId: 'ft1', status: 'ended', outcome: 'delivered', maxAttempts: 3, reportedShas: [] },
];
const finding: FindingSnapshot = {
  id: 'r1:0', originRoundId: 'r1', originRound: 1, originHeadSha: 'H1', ordinal: 0, path: 'install.sh', line: 4, title: 'Remove unrelated installer changes',
  required: true, status: 'open', lastRound: 2, addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null, deferredToTaskId: null,
  remedyClass: 'code_fix', restatedCount: 1,
};
const live = (h: string) => ({ state: 'open', merged: false, headSha: h });
let v = 0;
const T = (command: string, fromState: string | null, toState: string, evidence: Record<string, unknown> = {}, min = 0): ActivityTransition => ({
  command, fromState, toState, toVersion: ++v, evidence, createdAt: new Date(Date.UTC(2026, 9, 6, 10, min)).toISOString(),
});
v = 0;
const log: ActivityTransition[] = [
  T('DeliveryOpened', null, 'WORKING', {}, 0),
  T('AttemptEnded', 'WORKING', 'AWAITING_REVIEW', { outcome: 'success', live: live('H1') }, 1),
  T('ReviewVerdictRecorded', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', { roundId: 'r1' }, 2),
];
const header = (body: string) => body.split('\n')[1];
const view = (d: Partial<DeliverySnapshot>, extra: Partial<KernelView> = {}): KernelView => ({ delivery: D(d), rounds, attempts, findings: [finding], ...extra });

describe('renderDeliveryActivity: one state line (fa62b865 R-51, AC-62)', () => {
  test('a request for changes: the state line and Open in Buildd, nothing else', () => {
    const body = renderDeliveryActivity({ view: view({ state: 'CHANGES_REQUESTED' }), transitions: log, timezone: 'UTC' });
    expect(header(body)).toContain('**Changes requested · fix queued**');
    expect(header(body)).toContain('[Open in Buildd](');
    expect(body).not.toContain('Remove unrelated installer changes');
    expect(body).not.toContain('<details>');
    expect(body).not.toMatch(/^- /m);
    expect(body).not.toMatch(/Review:|Rounds:|Findings:|restated|Commented|fix 1 of 3/);
    expect(body).toContain('edited in place by');
    expect(parseRenderVersion(body)).toBe(5);
  });

  test('an escalation carries no decision prose: the question and actions live in Buildd', () => {
    const body = renderDeliveryActivity({ view: view({ state: 'ESCALATED', stateReason: 'review_exhausted' }), transitions: log, timezone: 'UTC' });
    expect(header(body)).toContain('⚑');
    expect(body).not.toMatch(/How should|Choices on the task page|Unresolved|Request another fix/);
    expect(body.split('\n').filter((l) => l.trim() && !l.startsWith('<!--')).length).toBe(2);
  });

  test("the line is the delivery's review reading, the same words the task page shows (AC-60)", () => {
    for (const d of [{ state: 'CHANGES_REQUESTED' }, { state: 'ESCALATED', stateReason: 'review_escalated' }, { state: 'AWAITING_REVIEW', stateReason: 'evidence' }, { state: 'MERGED' }] as Array<Partial<DeliverySnapshot>>) {
      const k = view(d);
      expect(header(renderDeliveryActivity({ view: k, transitions: log }))).toContain(`**${deriveDeliveryView({ view: k })!.review.stateLine}**`);
    }
  });

  test('is a pure function of state and log: two renders are identical', () => {
    const a = renderDeliveryActivity({ view: view({ state: 'APPROVED', approvalBasis: 'verdict', approvedHeads: ['H2'] }), transitions: log });
    expect(renderDeliveryActivity({ view: view({ state: 'APPROVED', approvalBasis: 'verdict', approvedHeads: ['H2'] }), transitions: log })).toBe(a);
    expect(a).not.toContain('buildd-activity-state');
  });

  test('"Approved" never heads a REPAIRING delivery; Merged stays the line', () => {
    expect(header(renderDeliveryActivity({ view: view({ state: 'REPAIRING', stateReason: 'ci' }), transitions: log }))).toContain('Fixing CI');
    expect(header(renderDeliveryActivity({ view: view({ state: 'MERGED', version: 7 }), transitions: log }))).toContain('**Merged**');
  });

  test('render-version marker round-trips', () => {
    expect(parseRenderVersion(`x\n${renderVersionMarker(42)}`)).toBe(42);
    expect(parseRenderVersion('legacy body')).toBeNull();
  });
});

describe('WORKING with the owner parked in the queue (loop pass, requeue) is not "Agent working"', () => {
  const working = (ts: ActivityTransition[]) =>
    renderDeliveryActivity({ view: { delivery: D({ state: 'WORKING', version: 9 }), rounds: [], attempts: [] }, transitions: ts, timezone: 'UTC' });

  test('a loop hold requeue, then CI readings, still reads as waiting for the next pass', () => {
    v = 0;
    const ts = [
      T('DeliveryOpened', null, 'WORKING', {}, 0),
      T('AttemptStarted', 'WORKING', 'WORKING', { start: true, taskId: 't1' }, 1),
      T('AttemptRequeued', 'WORKING', 'WORKING', { requeue: true, reason: 'loop_hold', taskId: 't1' }, 2),
      T('CiObserved', 'WORKING', 'WORKING', { verdict: 'red' }, 3),
    ];
    expect(ownerParkedIn(ts)).toBe(true);
    expect(working(ts)).toContain("Waiting for the agent's next pass");
  });

  test('the next claim starts it: Agent working again', () => {
    v = 0;
    const ts = [
      T('DeliveryOpened', null, 'WORKING', {}, 0),
      T('AttemptRequeued', 'WORKING', 'WORKING', { requeue: true, reason: 'loop_hold', taskId: 't1' }, 1),
      T('AttemptStarted', 'WORKING', 'WORKING', { start: true, taskId: 't1' }, 2),
    ];
    expect(ownerParkedIn(ts)).toBe(false);
    expect(working(ts)).toContain('Agent working');
  });

  test('an end the task retries, and a reopen to pending, park it; a reopen to assigned does not', () => {
    v = 0;
    expect(ownerParkedIn([T('AttemptEnded', 'WORKING', 'WORKING', { outcome: 'failed', requeue: true }, 1)])).toBe(true);
    expect(ownerParkedIn([T('AttemptReopened', 'WORKING', 'WORKING', { reopen: true, to: 'pending' }, 2)])).toBe(true);
    expect(ownerParkedIn([T('AttemptReopened', 'WORKING', 'WORKING', { reopen: true, to: 'assigned' }, 3)])).toBe(false);
    expect(ownerParkedIn([T('DeliveryOpened', null, 'WORKING', {}, 0)])).toBe(false);
  });
});
