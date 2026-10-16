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
const LINE = '2 rounds · latest: changes requested · 2 open findings';

describe('AC-24: the three surfaces agree on a delivery with two review rounds', () => {
  test('get_pr', () => {
    const report = prDeliveryReport(dv);
    expect(report.review).toMatchObject({ rounds: 2, latestVerdict: 'request_changes', openFindings: 2 });
    // No GitHub reviews: it still never says "Reviews: none".
    const { reviewLine } = formatGetPrDelivery({ reviews: { approved: 0, changesRequested: 0 }, delivery: report });
    expect(reviewLine).toBe(`Reviews: ${LINE}`);
  });

  test('the task page: the checks list and the PR card', () => {
    const checks = deriveTaskChecks(dv);
    expect(checks.review).toBe(LINE);
    const html = renderToStaticMarkup(
      <TaskChecks checks={checks} prNumber={42} prUrl="https://github.com/acme/app/pull/42" headSha="H2" findings={new Map()} currentTaskId="t1" />,
    );
    expect(html).toContain(`Review: ${LINE}`);
    const card = renderToStaticMarkup(
      <PrCard prUrl="https://github.com/acme/app/pull/42" prNumber={42} prLifecycleStatus="pr_open" prState={dv.prState} reviewRounds={checks.review} reviews={{ approved: 0, changesRequested: 0, pending: 0 }} ciChecks={{ total: 0, passed: 0, failed: 0, pending: 0, runs: [] }} />,
    );
    expect(card).toContain(LINE);
    expect(card).not.toContain('no reviews');
  });

  test('the PR activity comment', () => {
    const body = renderDeliveryActivity({ view, transitions: [] });
    expect(body).toContain(`Review: ${LINE}`);
    // Its findings block counts the same open findings.
    expect(body).toContain('Findings: 2 open of 3');
  });
});
