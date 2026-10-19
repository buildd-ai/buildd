/**
 * Task 2449c760: a review escalation names its cause, groups what is left and lists the
 * actions open to a person; an exhausted budget stays held (nothing here dispatches).
 * The first fixture is the shape of PR #4996: three reviews, two repairs, findings a push
 * touched but no review verified.
 */
import { describe, expect, test } from 'bun:test';
import { deriveEscalationBrief } from './escalation-brief';
import { deriveDeliveryView, type DeliveryViewInput } from './projections';
import type { AttemptSnapshot, DeliverySnapshot, FindingSnapshot, KernelView, RoundSnapshot } from './types';

const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
  state: 'ESCALATED', stateReason: 'review_exhausted', version: 9, currentHeadSha: 'H3', currentRound: 3, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const R = (n: number, o: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  id: `r${n}`, round: n, headSha: `H${n}`, kind: 'full', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes', failureCount: 0, ...o,
});
const A = (n: number, o: Partial<AttemptSnapshot> = {}): AttemptSnapshot => ({
  id: `a${n}`, family: 'review_fix', attemptNo: n, mode: 'agent', boundHeadSha: `H${n}`, triggerReason: `r${n}`, taskId: `ft${n}`,
  status: 'ended', outcome: 'success', maxAttempts: 2, reportedShas: [], ...o,
});
const F = (n: number, o: Partial<FindingSnapshot> = {}): FindingSnapshot => ({
  id: `f${n}`, originRoundId: 'r1', originRound: 1, originHeadSha: 'H1', ordinal: n, path: `src/f${n}.ts`, line: n, title: `finding ${n}`,
  required: true, status: 'open', lastRound: 3, addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null, deferredToTaskId: null, ...o,
});
const V = (d: DeliverySnapshot, o: Partial<KernelView> = {}): KernelView => ({ delivery: d, rounds: [R(1), R(2), R(3)], attempts: [A(1), A(2)], findings: [], ...o });

describe('deriveEscalationBrief', () => {
  test('PR #4996 shape: spent fixes name the cause and group stale addressed findings apart', () => {
    const b = deriveEscalationBrief(V(D(), {
      findings: [F(1), F(2, { status: 'addressed', addressedBySha: 'H2' }), F(3, { status: 'resolved' })],
    }))!;
    expect(b.cause).toBe('fixes_exhausted');
    expect(b.title).toBe('Automated fixes exhausted · 2 of 2 used');
    expect(b.findings.open.map((f) => f.id)).toEqual(['f1']);
    expect(b.findings.addressedAwaitingVerification).toEqual([expect.objectContaining({ id: 'f2', stale: true })]);
    expect(b.findings.resolved.map((f) => f.id)).toEqual(['f3']);
    expect(b.summary).toContain('Nothing runs again until you choose');
  });

  test('an addressed finding touched at the current head is not stale', () => {
    const b = deriveEscalationBrief(V(D(), { findings: [F(1, { status: 'addressed', addressedBySha: 'H3' })] }))!;
    expect(b.findings.addressedAwaitingVerification[0]!.stale).toBe(false);
  });

  test('unspent fix budget with rounds out is "Review required"', () => {
    const b = deriveEscalationBrief(V(D(), { attempts: [A(1)], findings: [F(1, { status: 'addressed', addressedBySha: 'H3' })] }))!;
    expect(b.cause).toBe('review_required');
    expect(b.title).toBe('Review required');
    expect(b.actions.find((a) => a.id === 'request_fix')!.available).toBe(false);
  });

  test('actions: nothing is automatic; override needs policy and merge permission', () => {
    const v = V(D(), { findings: [F(1)] });
    const ids = deriveEscalationBrief(v)!.actions.map((a) => a.id);
    expect(ids).toEqual(['review_findings', 'request_fix', 'force_re_review', 'approve_override']);
    const none = deriveEscalationBrief(v)!.actions.find((a) => a.id === 'approve_override')!;
    expect(none.available).toBe(false);
    expect(none.unavailableReason).toContain('policy');
    expect(deriveEscalationBrief(v, { overridePermitted: true })!.actions.find((a) => a.id === 'approve_override')!.unavailableReason).toContain('merge permission');
    expect(deriveEscalationBrief(v, { overridePermitted: true, hasMergePermission: true })!.actions.find((a) => a.id === 'approve_override')!.available).toBe(true);
    for (const a of deriveEscalationBrief(v)!.actions) expect(a.impact.length).toBeGreaterThan(0);
  });

  test('the host\'s sentence says why this viewer cannot override; it never hides an available override', () => {
    const v = V(D(), { findings: [F(1)] });
    const ov = (p: Parameters<typeof deriveEscalationBrief>[1]) => deriveEscalationBrief(v, p)!.actions.find((a) => a.id === 'approve_override')!;
    const role = 'Only a team owner or admin can approve past remaining findings.';
    expect(ov({ overridePermitted: false, hasMergePermission: false, overrideUnavailableReason: role })).toMatchObject({ available: false, unavailableReason: role });
    expect(ov({ overridePermitted: true, hasMergePermission: true, overrideUnavailableReason: role })).toMatchObject({ available: true, unavailableReason: null });
  });

  test('null outside a review-family escalation', () => {
    expect(deriveEscalationBrief(V(D({ state: 'AWAITING_REVIEW', stateReason: null })))).toBeNull();
    expect(deriveEscalationBrief(V(D({ stateReason: 'landing_needs_human' })))).toBeNull();
    expect(deriveEscalationBrief(V(D({ stateReason: 'ci_exhausted' })))).toBeNull();
  });

  test('the delivery view carries it', () => {
    const v = deriveDeliveryView({ view: V(D(), { findings: [F(1)] }) } as DeliveryViewInput)!;
    expect(v.escalation?.cause).toBe('fixes_exhausted');
    expect(v.cta?.action).toBe('open_pr');
  });
});

describe('Living Spec r7 AC-45 to AC-47', () => {
  test('AC-47: the brief groups partition the required findings; waived and deferred are their own groups, never resolved', () => {
    const b = deriveEscalationBrief(V(D(), {
      findings: [F(1), F(2, { status: 'addressed', addressedBySha: 'H3' }), F(3, { status: 'resolved' }), F(4, { status: 'waived' }), F(5, { status: 'deferred' }), F(6, { required: false })],
    }))!;
    expect(b.findings.open.map((f) => f.id)).toEqual(['f1']);
    expect(b.findings.addressedAwaitingVerification.map((f) => f.id)).toEqual(['f2']);
    expect(b.findings.resolved.map((f) => f.id)).toEqual(['f3']);
    expect(b.findings.waived.map((f) => f.id)).toEqual(['f4']);
    expect(b.findings.deferred.map((f) => f.id)).toEqual(['f5']);
    expect(b.totals).toEqual({ open: 1, addressedAwaitingVerification: 1, verifiedResolved: 1, waived: 1, deferred: 1, total: 5, advisory: 1 });
  });

  test('AC-45: the brief names the head and version a decision on it is bound to', () => {
    const b = deriveEscalationBrief(V(D(), { findings: [F(1)] }))!;
    expect(b.decisionHead).toEqual({ headSha: 'H3', version: 9 });
  });

  test('AC-47: the delivery view carries the same partition, and open + awaiting verification is what blocks', () => {
    const v = deriveDeliveryView({ view: V(D(), { findings: [F(1), F(2, { status: 'addressed', addressedBySha: 'H3' }), F(3, { status: 'resolved' })] }) } as DeliveryViewInput)!;
    expect(v.findingTotals).toEqual({ open: 1, addressedAwaitingVerification: 1, verifiedResolved: 1, waived: 0, deferred: 0, total: 3, advisory: 0 });
    expect(v.findingTotals.open + v.findingTotals.addressedAwaitingVerification).toBe(v.openFindings);
  });
});

describe('one reading across surfaces', () => {
  test('the delivery display and reading carry the cause, not "Waiting on you"', async () => {
    const { toDeliveryDisplay, deliveryReading } = await import('./delivery-display');
    const v = deriveDeliveryView({ view: V(D(), { findings: [F(1)] }) } as DeliveryViewInput)!;
    const r = deliveryReading(toDeliveryDisplay(v))!;
    expect(r.label).toBe('Automated fixes exhausted · 2 of 2 used');
    expect(r.needsYou).toBe(true);
    const plain = deriveDeliveryView({ view: V(D({ stateReason: 'landing_needs_human' })) } as DeliveryViewInput)!;
    expect(deliveryReading(toDeliveryDisplay(plain))!.label).toBe('Waiting on you');
  });
});
