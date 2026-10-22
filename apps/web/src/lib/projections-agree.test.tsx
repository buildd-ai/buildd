/**
 * AC-24 (docs/specs/workflow-kernel-library.md §7): one delivery with two
 * review rounds reads the same round count, latest verdict and open findings
 * in get_pr, on the task page and in the PR activity comment.
 *
 * One fixture, three surfaces, each through its own renderer.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatGetPrDelivery } from '@buildd/core/mcp-tools';
import TaskChecks from '@/app/app/(protected)/tasks/[id]/TaskChecks';
import PrCard from '@/components/task/PrCard';
import { prDeliveryReport } from './pr-delivery-report';
import { GITHUB_COMMENTED_NOTE } from './workflow/delivery-rounds';
import { deriveTaskChecks } from './task-checks';
import { renderDeliveryActivity } from './workflow/pr-activity-render';
import { deriveDeliveryView } from './workflow/projections';
import type { DeliverySnapshot, FindingSnapshot, KernelView, RoundSnapshot } from './workflow/types';

const delivery: DeliverySnapshot = {
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/app', prNumber: 42, baseRef: 'dev',
  state: 'CHANGES_REQUESTED', stateReason: null, version: 9, currentHeadSha: 'H2', currentRound: 2, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: 'green', ciHeadSha: 'H2', mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null,
};
const round = (n: number, head: string): RoundSnapshot => ({
  id: `r${n}`, round: n, headSha: head, kind: 'full', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes', failureCount: 0, reviewerTaskId: `rev${n}`,
});
const finding = (id: string, o: Partial<FindingSnapshot>): FindingSnapshot => ({
  id, originRoundId: 'r1', originRound: 1, originHeadSha: 'H1', ordinal: 0, path: 'src/a.ts', line: 3, title: 'rename the flag',
  required: true, status: 'open', lastRound: 2, addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null, deferredToTaskId: null, ...o,
});
const view: KernelView = {
  delivery,
  rounds: [round(1, 'H1'), round(2, 'H2')],
  attempts: [],
  findings: [
    finding('r1:0', {}),
    finding('r1:1', { ordinal: 1, status: 'resolved', closedByRoundId: 'r2' }),
    finding('r2:0', { originRoundId: 'r2', originRound: 2, originHeadSha: 'H2', title: 'add a test', required: false }),
  ],
};
const dv = deriveDeliveryView({ view })!;
// AC-47: each finding counted once: the required open one, the verified one, the optional one apart.
const LINE = '2 rounds · latest: changes requested · 1 open finding, 1 verified resolved, 1 advisory';
// Each round as buildd judged it, and that GitHub shows those reviews as Commented.
const ROUNDS = 'Round 1 at H1: changes requested · Round 2 at H2: changes requested';
const NOTE = GITHUB_COMMENTED_NOTE;

describe('AC-24: the three surfaces agree on a delivery with two review rounds', () => {
  test('get_pr', () => {
    const report = prDeliveryReport(dv);
    expect(report.review).toMatchObject({ rounds: 2, latestVerdict: 'request_changes', findings: { open: 1, addressedAwaitingVerification: 0, verifiedResolved: 1, waived: 0, deferred: 0, total: 2, advisory: 1 } });
    // No GitHub reviews: it still never says "Reviews: none".
    const { reviewLine } = formatGetPrDelivery({ reviews: { approved: 0, changesRequested: 0 }, delivery: report });
    expect(reviewLine).toBe(`Reviews: ${LINE}`);
  });

  test('get_pr: each round with buildd\'s verdict, apart from GitHub\'s Commented state', () => {
    const report = prDeliveryReport(dv);
    expect(report.rounds?.line).toBe(ROUNDS);
    const { roundsLine } = formatGetPrDelivery({ reviews: { approved: 0, changesRequested: 0 }, delivery: report });
    expect(roundsLine).toBe(`Review rounds: ${ROUNDS}. ${NOTE}`);
    expect(formatGetPrDelivery({ reviews: null, delivery: null }).roundsLine).toBe('');
  });

  test('R-43: get_pr names the Review approval apart from CI, in plain review terms', () => {
    const report = prDeliveryReport(dv);
    expect(report.reviewApproval).toEqual({ state: 'failure', description: 'Unresolved review finding: src/a.ts:3: rename the flag' });
    const { approvalLine } = formatGetPrDelivery({ reviews: { approved: 0, changesRequested: 0 }, delivery: report });
    expect(approvalLine).toBe('Review approval: Unresolved review finding: src/a.ts:3: rename the flag');
    expect(approvalLine).not.toMatch(/\bCI\b|\bland/);
    // A PR with no delivery says nothing about it rather than guessing.
    expect(formatGetPrDelivery({ reviews: null, delivery: null }).approvalLine).toBe('');
  });

  test('the task page: the checks list and the PR card', () => {
    const checks = deriveTaskChecks(dv);
    expect(checks.review).toBe(LINE);
    const html = renderToStaticMarkup(
      <TaskChecks checks={checks} prNumber={42} prUrl="https://github.com/acme/app/pull/42" headSha="H2" findings={new Map()} currentTaskId="t1" />,
    );
    expect(html).toContain(`Review: ${LINE}`);
    expect(checks.rounds).toEqual({ line: ROUNDS, githubNote: NOTE });
    expect(html).toContain(ROUNDS);
    expect(html).toContain(NOTE);
    const card = renderToStaticMarkup(
      <PrCard prUrl="https://github.com/acme/app/pull/42" prNumber={42} prLifecycleStatus="pr_open" prState={dv.prState} reviewRounds={checks.review} reviews={{ approved: 0, changesRequested: 0, pending: 0 }} ciChecks={{ total: 0, passed: 0, failed: 0, pending: 0, runs: [] }} />,
    );
    expect(card).toContain(LINE);
    expect(card).not.toContain('no reviews');
  });

  test('the PR activity comment stays compact and leaves round detail to the other surfaces', () => {
    const body = renderDeliveryActivity({ view, transitions: [] });
    expect(body).not.toContain('Review:');
    expect(body).not.toContain(ROUNDS);
    expect(body).not.toContain(NOTE);
    expect(body).not.toContain('Findings:');
  });
});

describe('AC-43: get_pr names what a stuck PR waits on and what the reader may do', () => {
  const esc: KernelView = {
    delivery: { ...delivery, state: 'ESCALATED', stateReason: 'review_exhausted', currentHeadSha: 'H3', currentRound: 3 },
    rounds: [round(1, 'H1'), round(2, 'H2'), round(3, 'H3')],
    attempts: [1, 2].map((n) => ({
      id: `a${n}`, family: 'review_fix' as const, attemptNo: n, mode: 'agent' as const, boundHeadSha: `H${n}`, triggerReason: `r${n}`, taskId: `ft${n}`,
      status: 'ended' as const, outcome: 'delivered' as const, maxAttempts: 2, reportedShas: [],
    })),
    findings: [
      finding('r1:0', { title: 'Mutation tests do not cover the new guard' }),
      finding('r1:1', { ordinal: 1, title: 'Verify against a real Postgres', status: 'addressed', addressedBySha: 'H3' }),
    ],
  };
  test('the question, why it stopped, each finding by name, and only the actions open now', () => {
    const report = prDeliveryReport(deriveDeliveryView({ view: esc })!);
    const { decisionLine, roundsLine } = formatGetPrDelivery({ reviews: null, delivery: report });
    expect(decisionLine).toContain('Decision: How should the two unresolved findings be settled?');
    expect(decisionLine).toContain('Automation stopped after three review rounds');
    expect(decisionLine).toContain('Still open: Mutation tests do not cover the new guard');
    expect(decisionLine).toContain('Fixed, waiting for a review: Verify against a real Postgres');
    expect(decisionLine).toContain('Open on the task page: Review findings, Request another fix, Request a forced re-review');
    expect(decisionLine).not.toMatch(/approve/i);
    expect(roundsLine).toContain('Round 3 at H3: changes requested');
  });
  test('no decision line when nothing is escalated', () => {
    expect(formatGetPrDelivery({ reviews: null, delivery: prDeliveryReport(dv) }).decisionLine).toBe('');
  });
});

describe('AC-24: GitHub COMMENTED is shown beside, never as, buildd\'s changes requested', () => {
  // Both rounds were posted on GitHub as COMMENTED reviews (the App opened the PR).
  const github = { approved: 0, changesRequested: 0, commented: 2 };
  test('get_pr prints both, apart', () => {
    const { reviewLine, roundsLine } = formatGetPrDelivery({ reviews: github, delivery: prDeliveryReport(dv) });
    expect(reviewLine).toBe(`Reviews: ${LINE}`);
    expect(roundsLine).toContain('Round 2 at H2: changes requested');
    expect(roundsLine).toContain('On GitHub: two reviews Commented');
  });
  test('the task page\'s PR card prints both', () => {
    const checks = deriveTaskChecks(dv);
    const card = renderToStaticMarkup(
      <PrCard prUrl="https://github.com/acme/app/pull/42" prNumber={42} prLifecycleStatus="pr_open" prState={dv.prState} reviewRounds={checks.review} reviews={{ ...github, pending: 0 }} ciChecks={{ total: 0, passed: 0, failed: 0, pending: 0, runs: [] }} />,
    );
    expect(card).toContain(LINE);
    expect(card).toContain('On GitHub: two reviews Commented');
  });
  test('the activity comment does not repeat the GitHub self-review explanation', () => {
    expect(renderDeliveryActivity({ view, transitions: [] })).not.toContain(NOTE);
  });
});

describe('AC-43 / AC-44 / AC-48: the PR activity comment carries the decision', () => {
  test('the #4996 shape: question, why, named findings, actions open now, no approval', () => {
    const esc: KernelView = {
      delivery: { ...delivery, state: 'ESCALATED', stateReason: 'review_exhausted', currentHeadSha: 'H3', currentRound: 3 },
      rounds: [round(1, 'H1'), round(2, 'H2'), round(3, 'H3')],
      attempts: [1, 2].map((n) => ({
        id: `a${n}`, family: 'review_fix' as const, attemptNo: n, mode: 'agent' as const, boundHeadSha: `H${n}`, triggerReason: `r${n}`, taskId: `ft${n}`,
        status: 'ended' as const, outcome: 'delivered' as const, maxAttempts: 2, reportedShas: [],
      })),
      findings: [
        finding('r1:0', { title: 'Mutation tests do not cover the new guard' }),
        finding('r1:1', { ordinal: 1, title: 'Verify against a real Postgres', status: 'addressed', addressedBySha: 'H3' }),
      ],
    };
    const body = renderDeliveryActivity({ view: esc, transitions: [] });
    expect(body).toContain('**How should the two unresolved findings be settled?**');
    expect(body).toContain('Automation stopped after three review rounds');
    expect(body).toContain('Still open: Mutation tests do not cover the new guard');
    expect(body).toContain('Fixed, waiting for a review: Verify against a real Postgres');
    expect(body).toContain('Open on the task page: Review findings, Request another fix, Request a forced re-review');
    expect(body).not.toMatch(/Approve and override/);
  });
});
