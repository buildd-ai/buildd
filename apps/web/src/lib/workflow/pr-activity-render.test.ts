/**
 * S26 (docs/specs/workflow-state-kernel.md §12.1): the PR activity comment is a
 * projection of the delivery and its transition log, never an append log.
 */
import { describe, expect, test } from 'bun:test';
import {
  parseRenderVersion,
  renderDeliveryActivity,
  renderVersionMarker,
  transitionsToActivityEntries,
  type ActivityTransition,
} from './pr-activity-render';
import type { AttemptSnapshot, DeliverySnapshot, KernelView, RoundSnapshot } from './types';

const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
  state: 'WORKING', stateReason: null, version: 5, currentHeadSha: 'H2', currentRound: 2, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const rounds: RoundSnapshot[] = [
  { id: 'r1', round: 1, headSha: 'H1', kind: 'full', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes', failureCount: 0 },
  { id: 'r2', round: 2, headSha: 'H2', kind: 'delta', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', failureCount: 0 },
];
const attempts: AttemptSnapshot[] = [
  { id: 'a1', family: 'review_fix', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: 'r1', taskId: 'ft1', status: 'ended', outcome: 'delivered', maxAttempts: 3, reportedShas: [] },
];
const live = (h: string) => ({ state: 'open', merged: false, headSha: h });
let v = 0;
const T = (command: string, fromState: string | null, toState: string, evidence: Record<string, unknown> = {}, min = 0): ActivityTransition => ({
  command, fromState, toState, toVersion: ++v, evidence, createdAt: new Date(Date.UTC(2026, 9, 6, 10, min)).toISOString(),
});
v = 0;
const log: ActivityTransition[] = [
  T('DeliveryOpened', null, 'WORKING', {}, 0),
  T('AttemptEnded', 'WORKING', 'AWAITING_REVIEW', { outcome: 'success', live: live('H1') }, 1),
  T('ReviewVerdictRecorded', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', { roundId: 'r1', verdict: 'request_changes', effectiveVerdict: 'request_changes' }, 2),
  T('FixClaimed', 'CHANGES_REQUESTED', 'FIXING', { attemptId: 'a1', roundId: 'r1', live: live('H1') }, 3),
  T('AttemptEnded', 'FIXING', 'AWAITING_REVIEW', { outcome: 'success', live: live('H2'), proof: { liveContainsLocal: true } }, 4),
  T('ReviewVerdictRecorded', 'AWAITING_REVIEW', 'APPROVED', { roundId: 'r2', verdict: 'approve', effectiveVerdict: 'approve' }, 5),
];
const kinds = (ts: ActivityTransition[]) => transitionsToActivityEntries(ts, rounds, attempts).map((e) => e.kind);
const header = (body: string) => body.split('\n')[1];

describe('transitions → timeline', () => {
  test('the fix loop renders once per transition, with the push between fix and re-review', () => {
    expect(kinds(log)).toEqual([
      'review_queued', 'review_changes_requested', 'fix_started', 'changes_pushed', 'fix_ended', 'review_queued', 'review_approved',
    ]);
  });

  test('a fix that ended without a push renders push_pending, not fix_ended then a review', () => {
    const ts = [...log.slice(0, 4), T('AttemptEnded', 'FIXING', 'AWAITING_PUSH', { outcome: 'success', live: live('H1') }, 4)];
    expect(kinds(ts).slice(-2)).toEqual(['fix_started', 'push_pending']);
  });

  test('fix lines carry the 1-based ledger attempt', () => {
    const e = transitionsToActivityEntries(log, rounds, attempts).find((x) => x.kind === 'fix_started')!;
    expect({ iteration: e.iteration, maxIterations: e.maxIterations }).toEqual({ iteration: 1, maxIterations: 3 });
  });
});

describe('renderDeliveryActivity (S26)', () => {
  const view = (d: Partial<DeliverySnapshot>): KernelView => ({ delivery: D(d), rounds, attempts });

  test('is a pure function of state and log: two renders are identical', () => {
    const a = renderDeliveryActivity({ view: view({ state: 'APPROVED', approvalBasis: 'verdict', approvedHeads: ['H2'] }), transitions: log });
    const b = renderDeliveryActivity({ view: view({ state: 'APPROVED', approvalBasis: 'verdict', approvedHeads: ['H2'] }), transitions: log });
    expect(a).toBe(b);
    expect(parseRenderVersion(a)).toBe(5);
    expect(a).not.toContain('buildd-activity-state');
  });

  test('Merged stays the headline whatever is recorded after it', () => {
    const merged = [...log, T('PrMerged', 'APPROVED', 'MERGED', { live: live('H2') }, 6)];
    const body = renderDeliveryActivity({
      view: view({ state: 'MERGED', version: 7 }), transitions: merged,
      notes: [{ entry: { kind: 'reviewing', at: '2026-10-06T10:09:00.000Z' }, observedAt: '2026-10-06T10:09:00.000Z' }],
    });
    expect(header(body)).toContain('**Merged**');
    expect(body).not.toContain('Reviewing');
  });

  test('"Approved" never heads a REPAIRING delivery', () => {
    const body = renderDeliveryActivity({ view: view({ state: 'REPAIRING', stateReason: 'ci' }), transitions: log });
    expect(header(body)).not.toContain('Approved');
    expect(header(body)).toContain('Fixing CI');
  });

  test('a verified composition reads "Release composition verified"', () => {
    const ts = [T('PrBound', null, 'AWAITING_REVIEW', { live: live('H2') }, 0), T('CompositionAttested', 'AWAITING_REVIEW', 'APPROVED', { novelDelta: { result: 'none' } }, 1)];
    const body = renderDeliveryActivity({ view: view({ state: 'APPROVED', approvalBasis: 'composition', compositionHeads: ['H2'] }), transitions: ts });
    expect(header(body)).toContain('Release composition verified');
    expect(body).toContain('Release composition verified');
  });

  test('diverted notes: kinds a transition owns are dropped, the rest are kept', () => {
    const body = renderDeliveryActivity({
      view: view({ state: 'APPROVED', approvedHeads: ['H2'], approvalBasis: 'verdict' }), transitions: log,
      notes: [
        { entry: { kind: 'review_approved', at: '2026-10-06T10:05:30.000Z' }, observedAt: '2026-10-06T10:05:30.000Z' },
        { entry: { kind: 'ci_fixing', iteration: 1, maxIterations: 3, at: '2026-10-06T10:04:30.000Z' }, observedAt: '2026-10-06T10:04:30.000Z' },
      ],
    });
    expect(body.match(/ Approved/g)?.length).toBe(1);
    expect(body).toContain('CI failed');
  });

  test('render-version marker round-trips', () => {
    expect(parseRenderVersion(`x\n${renderVersionMarker(42)}`)).toBe(42);
    expect(parseRenderVersion('legacy body')).toBeNull();
  });
});
