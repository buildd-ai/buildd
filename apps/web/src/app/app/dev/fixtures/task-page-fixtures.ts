/**
 * `?state=task-page&case=<case>`: the task page's head (track, outcome row,
 * checks, result) for each regression case in docs/specs/task-page.md, built
 * through the real derivations (deriveDeliveryView, headerLifecycle,
 * deriveTaskChecks, deriveTaskVerdict, buildTaskShippedView) from illustrative
 * kernel snapshots. Nothing here is production data.
 */
import { deriveDeliveryView, type DeliveryView } from '@/lib/workflow/projections';
import type { AttemptSnapshot, DeliverySnapshot, RoundSnapshot } from '@/lib/workflow/types';
import { deriveTaskChecks, type TaskChecks } from '@/lib/task-checks';
import { deriveTaskVerdict, type TaskVerdict, type VerdictInput } from '@/lib/task-verdict';
import { buildTaskShippedView, type TaskShippedView } from '../../(protected)/tasks/[id]/task-shipped-header';
import { headerLifecycle } from '../../(protected)/tasks/[id]/task-header';
import type { StateKey } from '@/components/ui/states';
import type { ReadableResult } from '@/lib/review-result';

export const TASK_PAGE_CASES = ['review-approved', 'branch-refresh', 'repair', 'merged', 'failed', 'needs-human'] as const;
export type TaskPageCase = typeof TASK_PAGE_CASES[number];

export const parseTaskPageCase = (v: string | null): TaskPageCase =>
  (TASK_PAGE_CASES as readonly string[]).includes(v ?? '') ? v as TaskPageCase : 'review-approved';

const HEAD_A = 'a1b2c3d4e5f6';
const HEAD_B = 'f6e5d4c3b2a1';
const PR_URL = 'https://github.com/example/app/pull/1234';

const D = (o: Partial<DeliverySnapshot>): DeliverySnapshot => ({
  id: 'd', workspaceId: 'w', ownerTaskId: 'deliverable', repoFullName: 'example/app', prNumber: 1234, baseRef: 'dev',
  state: 'WORKING', stateReason: null, version: 1, currentHeadSha: HEAD_B, currentRound: 1, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [], approvalBasis: null,
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const R = (o: Partial<RoundSnapshot>): RoundSnapshot => ({
  id: 'r1', round: 1, headSha: HEAD_B, kind: 'full', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', failureCount: 0, reviewerTaskId: 'review-1', ...o,
});
const A = (o: Partial<AttemptSnapshot>): AttemptSnapshot => ({
  id: 'a', family: 'ci', attemptNo: 1, mode: 'agent', boundHeadSha: HEAD_B, triggerReason: 'ci', taskId: 'fix-1',
  status: 'running', outcome: null, maxAttempts: 3, reportedShas: [], ...o,
});

const APPROVED_ROUND = R({});
const REVIEW_SUMMARY = 'The change does what the task asks: both PRs land and the stuck escalation clears.\n\nTests cover the refresh hold and the stale escalation. No blocking findings.';

export interface TaskPageFixture {
  title: string;
  subjectLink: string | null;
  track: { state: StateKey; phrase: string | null } | null;
  verdict: TaskVerdict;
  checks: TaskChecks;
  view: DeliveryView;
  shipped: TaskShippedView | null;
  findings: Map<string, Pick<ReadableResult, 'prose' | 'verdict'>>;
  currentTaskId: string;
}

const verdictInput = (o: Partial<VerdictInput>): VerdictInput => ({
  taskStatus: 'completed', live: null, openQuestion: false, pr: null, checks: null, openAttempt: null, ...o,
});
const shippedInput = (o: Partial<Parameters<typeof buildTaskShippedView>[0]>) => buildTaskShippedView({
  taskStatus: 'completed', taskMode: 'execution', conventionalType: 'fix', category: null, record: null,
  summary: null, summarySource: 'agent', heroShots: [], ...o,
});

export function taskPageFixture(c: TaskPageCase): TaskPageFixture {
  let delivery: DeliverySnapshot;
  let rounds: RoundSnapshot[] = [APPROVED_ROUND];
  let attempts: AttemptSnapshot[] = [];
  let verdict: TaskVerdict;
  let shipped: TaskShippedView | null = null;
  let currentTaskId = 'deliverable';
  let subjectLink: string | null = null;
  let title = 'Finish landing the recovery fixes';
  const pr = { url: PR_URL, number: 1234, lifecycle: 'ci_green', merged: false };

  switch (c) {
    case 'review-approved':
      delivery = D({ state: 'APPROVED', approvalBasis: 'verdict', approvedHeads: [HEAD_B], ci: 'green', ciHeadSha: HEAD_B });
      currentTaskId = 'review-1';
      subjectLink = title;
      title = 'PR #1234: Finish landing the recovery fixes';
      verdict = deriveTaskVerdict(verdictInput({ review: { verdict: 'approve' }, pr }))!;
      shipped = shippedInput({
        conventionalType: null,
        summary: JSON.stringify({ summary: REVIEW_SUMMARY, verdict: 'approve', confidence: 0.8 }),
        subject: { kind: 'review', prNumber: 1234 }, shipped: false,
      });
      break;
    case 'branch-refresh':
      delivery = D({ state: 'REPAIRING', stateReason: 'behind', approvalBasis: 'verdict', approvedHeads: [HEAD_B], boundAttemptId: 'm1', ci: 'green', ciHeadSha: HEAD_B });
      attempts = [A({ id: 'm1', family: 'conflict', mode: 'mechanical', triggerReason: 'behind', taskId: null })];
      verdict = deriveTaskVerdict(verdictInput({ pr: { ...pr, lifecycle: 'ci_running' } }))!;
      shipped = shippedInput({ summary: 'Landed both PRs behind the recovery fix.', shipped: false });
      break;
    case 'repair':
      delivery = D({ state: 'REPAIRING', stateReason: 'ci', boundAttemptId: 'c1', ci: 'red', ciHeadSha: HEAD_B });
      rounds = [];
      attempts = [A({ id: 'c1' })];
      verdict = deriveTaskVerdict(verdictInput({
        pr: { ...pr, lifecycle: 'ci_failed' },
        checks: [{ name: 'Unit tests', state: 'failed', url: `${PR_URL}/checks`, line: 'expected "Updating branch", received "Repairing"' }],
        openAttempt: { taskId: 'fix-1', iteration: 1, maxIterations: 3, claimed: true },
      }))!;
      break;
    case 'merged':
      delivery = D({ state: 'MERGED', mergedAt: '2026-10-11T10:00:00Z', approvedHeads: [HEAD_B], approvalBasis: 'verdict' });
      rounds = [
        R({ id: 'r1', round: 1, headSha: HEAD_A, verdict: 'request_changes', effectiveVerdict: 'request_changes', reviewerTaskId: 'review-0' }),
        R({ id: 'r2', round: 2, reviewerTaskId: 'review-1' }),
      ];
      attempts = [A({ id: 'f1', family: 'review_fix', triggerReason: 'r1', boundHeadSha: HEAD_A, status: 'ended', outcome: 'delivered' })];
      verdict = deriveTaskVerdict(verdictInput({ pr: { ...pr, merged: true, lifecycle: 'merged' } }))!;
      shipped = shippedInput({ record: { version: 1, lede: 'A review run now reads as a review of its task, and a branch refresh no longer reads as a repair.', changeType: 'frontend', offPlan: [], prNumber: 1234, computedAt: '' }, summary: 'Rewrote the task page head.', shipped: true });
      break;
    case 'failed':
      delivery = D({ state: 'FAILED', stateReason: 'the run ended before opening a PR', prNumber: null });
      rounds = [];
      verdict = deriveTaskVerdict(verdictInput({ taskStatus: 'failed', failureLine: 'npm ERR! missing script: build' }))!;
      break;
    case 'needs-human':
      delivery = D({ state: 'ESCALATED', stateReason: 'review_escalated' });
      rounds = [R({ verdict: 'escalate', effectiveVerdict: 'escalate' })];
      verdict = deriveTaskVerdict(verdictInput({ taskStatus: 'in_progress', openQuestion: true, live: { status: 'waiting_input', waitingForInput: true } }))!;
      break;
  }
  const view = deriveDeliveryView({ view: { delivery, rounds, attempts } })!;
  return {
    title,
    subjectLink,
    track: headerLifecycle(view),
    verdict,
    checks: deriveTaskChecks(view),
    view,
    shipped,
    findings: new Map([['review-1', { prose: REVIEW_SUMMARY, verdict: 'approve' }], ['review-0', { prose: 'The refresh path still labels itself a repair.', verdict: 'request-changes' }]]),
    currentTaskId,
  };
}
