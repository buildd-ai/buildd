import { describe, expect, it } from 'bun:test';
import { deriveHomeNeedsYou } from './home-needs-you';
import { buildActionQueue, isActionableChip, type ActionQueueItem } from './action-queue';
import { resolveHumanPrReview } from './reviewer-gate';

// Needs you is only what Buildd can't resolve. A human review whose PR is
// still being repaired or checked waits for that to settle: reviewing a diff a
// conflict repair is about to rewrite is wasted. It is named once, in the quiet
// "Also in progress" line, and the headline, badge and list never count it.
const now = new Date();
const escalation = { status: 'completed' as const, result: { structuredOutput: { verdict: 'escalate', summary: 'protected migration paths' } }, context: { headSha: 'head' } };
const humanReview = resolveHumanPrReview({ reviewerTask: escalation, currentHeadSha: 'head', escalationReason: null, policyTier: 'agent-review', github: { reviewDecision: 'REVIEW_REQUIRED', humanApproved: false } });
// The real queue builder, so the fixture is whatever Home actually receives.
const review = (n: number, extra: Record<string, unknown> = {}): ActionQueueItem => buildActionQueue([], [{
  workerId: `w${n}`, taskId: `t${n}`, taskTitle: `Change ${n}`, workspaceId: 'ws', workspaceName: 'Example',
  prUrl: `https://github.com/example/project/pull/${n}`, prNumber: n, policyTier: 'human', waitingMinutes: 1,
  escalationReason: null, prOpenedAt: now, prLifecycleVerifiedAt: now, humanReview, prLifecycleStatus: 'ci_green', ...extra,
} as never], { now })[0];
const derive = (queue: ActionQueueItem[]) => deriveHomeNeedsYou({ queue, missions: [], questions: [], held: [], isActionable: isActionableChip });

describe('a review waits while Buildd is still acting on its PR', () => {
  it.each([
    ['a conflict repair is queued', { conflictRetryTaskId: 'repair' }],
    ['CI is running', { prLifecycleStatus: 'ci_running' }],
    ['a CI fix is in flight', { ciGate: { kind: 'fixing', fixKind: 'ci', taskId: 'fix' } }],
    ['a reviewer agent is re-reviewing', { reviewInFlight: 'reviewing' }],
  ] as const)('%s: not a decision, counted as in progress', (_name, extra) => {
    const out = derive([review(1, extra)]);
    expect(out.items).toHaveLength(0);
    expect(out.count).toBe(0);
    expect(out.inProgress).toBe(1);
  });

  it.each([
    ['checks passed and nothing is running', {}],
    ['CI failed with no fix running', { prLifecycleStatus: 'ci_failed' }],
    ['conflict repair gave up', { conflictRetryTaskId: 'repair', deadZoneExhausted: true }],
    ['the branch conflicts and no repair is queued', { prLifecycleStatus: 'conflict' }],
  ] as const)('%s: still needs you', (_name, extra) => {
    const out = derive([review(2, extra)]);
    expect(out.items).toHaveLength(1);
    expect(out.count).toBe(1);
    expect(out.inProgress).toBe(0);
  });

  it('the count is the list length when both kinds are present', () => {
    const out = derive([review(3), review(4, { conflictRetryTaskId: 'r' }), review(5, { prLifecycleStatus: 'ci_running' })]);
    expect(out.count).toBe(out.items.length);
    expect(out.count).toBe(1);
    expect(out.inProgress).toBe(2);
  });
});
