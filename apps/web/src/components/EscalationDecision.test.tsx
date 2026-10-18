/**
 * AC-43 / AC-48 (spec r7 §7): the decision card leads with the question, names every
 * unresolved finding, says why automation stopped and shows only the actions this
 * person may take, with the primary one named for what it does.
 */
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { default: EscalationDecision } = await import('./EscalationDecision');
const { decisionCopy } = await import('@/lib/workflow/escalation-copy');
const { deriveEscalationBrief } = await import('@buildd/workflow-kernel/escalation-brief');
import type { DeliverySnapshot, FindingSnapshot, KernelView, RoundSnapshot, AttemptSnapshot } from '@buildd/workflow-kernel/types';

const D: DeliverySnapshot = {
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
  state: 'ESCALATED', stateReason: 'review_exhausted', version: 9, currentHeadSha: 'H3', currentRound: 3, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null,
};
const R = (n: number): RoundSnapshot => ({ id: `r${n}`, round: n, headSha: `H${n}`, kind: 'full', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes', failureCount: 0 });
const A = (n: number): AttemptSnapshot => ({ id: `a${n}`, family: 'review_fix', attemptNo: n, mode: 'agent', boundHeadSha: `H${n}`, triggerReason: `r${n}`, taskId: `ft${n}`, status: 'ended', outcome: 'delivered', maxAttempts: 2, reportedShas: [] });
const F = (n: number, title: string, o: Partial<FindingSnapshot> = {}): FindingSnapshot => ({
  id: `f${n}`, originRoundId: 'r1', originRound: 1, originHeadSha: 'H1', ordinal: n, path: null, line: null, title,
  required: true, status: 'open', lastRound: 3, addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null, deferredToTaskId: null, ...o,
});
const view: KernelView = {
  delivery: D, rounds: [R(1), R(2), R(3)], attempts: [A(1), A(2)],
  findings: [F(1, 'Mutation tests do not cover the new guard'), F(2, 'Verify against a real Postgres', { status: 'addressed', addressedBySha: 'H3' })],
};

describe('EscalationDecision', () => {
  test('named findings and only authorized actions, without repeating the verdict row', () => {
    const brief = deriveEscalationBrief(view)!;
    const copy = decisionCopy(brief, { rounds: view.rounds, ledger: view.attempts });
    const html = renderToStaticMarkup(<EscalationDecision brief={brief} copy={copy} prNumber={7} workspaceId="w1" />);
    // The verdict row above carries the question and why; the card is labelled by the question and names what is left.
    expect(html).toContain('aria-label="How should the two unresolved findings be settled?"');
    expect(html).not.toContain('Automation stopped');
    expect(html).toContain('Mutation tests do not cover the new guard');
    expect(html).toContain('Verify against a real Postgres');
    expect(html).toContain('data-testid="decision-action-review_findings"');
    expect(html).toContain('data-testid="decision-action-request_fix"');
    expect(html).toContain('data-testid="decision-action-force_re_review"');
    expect(html).not.toContain('decision-action-approve_override');
    expect(html).not.toMatch(/Approve and override|Waiting on you|Unavailable:/);
    // The primary is the shared primary button, named for the action.
    expect(html).toMatch(/btn-primary[^>]*data-testid="decision-action-request_fix"|data-testid="decision-action-request_fix"[^>]*btn-primary/);
  });
});

describe('EscalationDecision confirm', () => {
  test('posts the head and version the card showed, and shows a stale refusal in its own words', async () => {
    const src = await Bun.file(new URL('./EscalationDecision.tsx', import.meta.url)).text();
    expect(src).toContain('headSha: brief.decisionHead.headSha, version: brief.decisionHead.version');
    expect(src).toContain('data.error');
  });
});
