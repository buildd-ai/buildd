/**
 * AC-43 / AC-48 (spec r7 §7): a PR stuck after three review rounds leads with the
 * question, names its unresolved findings, says why automation stopped, and offers
 * Review findings plus only the actions this person may take, never a presumed
 * approval. The fixture is the shape of a real escalation: three rounds asking for
 * changes, both automatic fixes spent, two verification findings left.
 */
import { describe, expect, test } from 'bun:test';
import { deriveEscalationBrief } from '@buildd/workflow-kernel/escalation-brief';
import type { AttemptSnapshot, DeliverySnapshot, FindingSnapshot, KernelView, RoundSnapshot } from '@buildd/workflow-kernel/types';
import { decisionActionHref, decisionCopy, parseDecisionHash } from '@/lib/workflow/escalation-copy';

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
  status: 'ended', outcome: 'delivered', maxAttempts: 2, reportedShas: [], ...o,
});
const F = (n: number, title: string, o: Partial<FindingSnapshot> = {}): FindingSnapshot => ({
  id: `f${n}`, originRoundId: 'r1', originRound: 1, originHeadSha: 'H1', ordinal: n, path: null, line: null, title,
  required: true, status: 'open', lastRound: 3, addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null, deferredToTaskId: null, ...o,
});

const rounds = [R(1), R(2), R(3)];
const ledger = [A(1), A(2)];
const view = (findings: FindingSnapshot[], o: Partial<KernelView> = {}): KernelView => ({ delivery: D(), rounds, attempts: ledger, findings, ...o });
const stuck = view([
  F(1, 'Mutation tests do not cover the new guard'),
  F(2, 'Verify against a real Postgres, not the mocked db', { status: 'addressed', addressedBySha: 'H3' }),
  F(3, 'Rename the flag', { status: 'resolved' }),
]);

describe('decisionCopy', () => {
  test('leads with the question and counts in words', () => {
    const c = decisionCopy(deriveEscalationBrief(stuck)!, { rounds, ledger });
    expect(c.question).toBe('How should the two unresolved findings be settled?');
    expect(c.question).not.toMatch(/\d/);
  });

  test('names each unresolved finding, grouped by whether a fix is waiting for a review', () => {
    const c = decisionCopy(deriveEscalationBrief(stuck)!, { rounds, ledger });
    expect(c.unresolved.open).toEqual(['Mutation tests do not cover the new guard']);
    expect(c.unresolved.awaitingVerification).toEqual(['Verify against a real Postgres, not the mocked db']);
  });

  test('explains why automation stopped: rounds and fixes spent, in words', () => {
    const c = decisionCopy(deriveEscalationBrief(stuck)!, { rounds, ledger });
    expect(c.why).toBe('Automation stopped after three review rounds: both automatic fixes ran and the review still asks for changes. Nothing runs again until someone chooses.');
    expect(c.why).not.toMatch(/\d/);
    expect(c.why).not.toMatch(/waiting on you/i);
  });

  test('a superseded round is not counted', () => {
    const r = [...rounds, R(4, { status: 'superseded', verdict: null, effectiveVerdict: null })];
    expect(decisionCopy(deriveEscalationBrief(view(stuck.findings!, { rounds: r }))!, { rounds: r, ledger }).why).toContain('three review rounds');
  });

  test('only fixes awaiting a review: says the review budget ran out before they were checked', () => {
    const v = view([F(1, 'Add the index', { status: 'addressed', addressedBySha: 'H3' })], { attempts: [A(1)] });
    const c = decisionCopy(deriveEscalationBrief(v)!, { rounds, ledger: [A(1)] });
    expect(c.question).toBe('How should the unresolved finding be settled?');
    expect(c.why).toBe('Automation stopped after three review rounds: a fix was pushed, and no review round is left to check it. Nothing runs again until someone chooses.');
  });

  test('offers Review findings plus only actions this person may take; never an approval it cannot back', () => {
    const c = decisionCopy(deriveEscalationBrief(stuck)!, { rounds, ledger });
    expect(c.actions.map((a) => a.id)).toEqual(['review_findings', 'request_fix', 'force_re_review']);
    expect(c.actions.every((a) => a.available)).toBe(true);
    expect(c.actions.some((a) => a.id === 'approve_override')).toBe(false);
    // Policy allows it but this viewer lacks merge permission: still not offered.
    const noMerge = decisionCopy(deriveEscalationBrief(stuck, { overridePermitted: true, hasMergePermission: false })!, { rounds, ledger });
    expect(noMerge.actions.some((a) => a.id === 'approve_override')).toBe(false);
  });

  test('approve and override is offered when the server says this viewer may, and is never the primary', () => {
    const permitted = decisionCopy(deriveEscalationBrief(stuck, { overridePermitted: true, hasMergePermission: true })!, { rounds, ledger });
    expect(permitted.actions.map((a) => a.id)).toEqual(['review_findings', 'request_fix', 'force_re_review', 'approve_override']);
    expect(permitted.primary.id).toBe('request_fix');
  });

  test('the primary action is the one that moves the PR: a fix when one is open, else a re-review', () => {
    expect(decisionCopy(deriveEscalationBrief(stuck)!, { rounds, ledger }).primary.id).toBe('request_fix');
    const onlyAddressed = view([F(1, 'Add the index', { status: 'addressed', addressedBySha: 'H3' })]);
    const c = decisionCopy(deriveEscalationBrief(onlyAddressed)!, { rounds, ledger });
    expect(c.primary.id).toBe('force_re_review');
    expect(c.actions.map((a) => a.id)).toEqual(['review_findings', 'force_re_review']);
  });

  test('with no head to act on, Review findings is the one thing left', () => {
    const v: KernelView = { ...stuck, delivery: D({ currentHeadSha: null }), findings: [F(1, 'x', { status: 'addressed' })] };
    const c = decisionCopy(deriveEscalationBrief(v)!, { rounds, ledger });
    expect(c.actions.map((a) => a.id)).toEqual(['review_findings']);
    expect(c.primary.id).toBe('review_findings');
  });
});

test('no review round yet has its own words', () => {
  const v = view([F(1, 'x')], { rounds: [] });
  const c = decisionCopy(deriveEscalationBrief(v)!, { rounds: [], ledger });
  expect(c.why.startsWith('Automation stopped before any review round finished')).toBe(true);
  expect(c.why).not.toContain('no review rounds');
});

describe('decision hash', () => {
  test('round-trips an action id, and ignores anything else', () => {
    expect(decisionActionHref('request_fix')).toBe('#task-decision-request_fix');
    expect(parseDecisionHash('#task-decision-request_fix')).toBe('request_fix');
    expect(parseDecisionHash('#task-decision')).toBeNull();
    expect(parseDecisionHash('#task-decision-approve_override')).toBe('approve_override');
    expect(parseDecisionHash('#task-decision-merge')).toBeNull();
    expect(parseDecisionHash('#review-findings')).toBeNull();
  });
});
