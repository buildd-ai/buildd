import { describe, it, expect } from 'bun:test';
import { resolveHumanPrReview, isCurrentReviewApproved } from './reviewer-gate';
import { buildActionQueue, isActionableChip } from './action-queue';
import { deriveHomeAttention } from './home-attention';
import { readFileSync } from 'node:fs';
const now = new Date();
const escalation = { status: 'completed' as const, result: { structuredOutput: { verdict: 'escalate', summary: 'protected migration paths' } }, context: { headSha: 'head' } };
const base = { reviewerTask: escalation, currentHeadSha: 'head', escalationReason: null, policyTier: 'agent-review', github: { reviewDecision: 'REVIEW_REQUIRED', humanApproved: false } };
const card = (humanReview: ReturnType<typeof resolveHumanPrReview>, extra = {}) => buildActionQueue([], [{ workerId: 'local', taskId: 'task', taskTitle: 'A change', workspaceId: 'example', workspaceName: 'Example', prUrl: 'https://github.com/example/project/pull/7', prNumber: 7, policyTier: 'human', waitingMinutes: 1, escalationReason: null, prOpenedAt: now, prLifecycleVerifiedAt: now, humanReview, ...extra }], { now })[0];
describe('human approval is independent of merge readiness', () => {
  it.each(['ci_running', 'ci_failed', 'conflict'])('escalation + %s stays REVIEW without a merge action', lifecycle => {
    const item = card(resolveHumanPrReview(base), { prLifecycleStatus: lifecycle });
    expect(item.chip).toBe('REVIEW');
    expect(item.humanReview?.reason).toContain('protected migration paths');
    expect(isActionableChip(item.chip)).toBe(true);
  });
  it('a current human approval clears the escalation while CI continues', () => {
    const action = resolveHumanPrReview({ ...base, github: { reviewDecision: 'APPROVED', humanApproved: true } });
    expect(action).toBeNull();
    expect(card(action, { prLifecycleStatus: 'ci_running' }).chip).toBe('CI_RUNNING');
  });
  it('internal approve cannot satisfy GitHub-required approval', () => {
    expect(resolveHumanPrReview({ ...base, reviewerTask: { ...escalation, result: { structuredOutput: { verdict: 'approve' } } } })?.label).toBe('Approve on GitHub');
  });
  it('green + satisfied approval offers MERGE only for manual policy', () => {
    expect(card(null, { prLifecycleStatus: 'ci_green' }).chip).toBe('MERGE');
    expect(card(null, { prLifecycleStatus: 'ci_green', autoMerge: true }).chip).toBe('AUTO_MERGE');
  });
  it('an old machine-only duplicate cannot hide a current human review', () => {
    const review = card(resolveHumanPrReview(base), { prLifecycleStatus: 'ci_running' });
    const pending = { ...review, chip: 'CI_RUNNING' as const, humanReview: null };
    for (const queue of [[review, pending], [pending, review]]) {
      expect(deriveHomeAttention({ queue, missions: [], questions: [], held: [], isActionable: isActionableChip })[0]?.queue?.humanReview).toEqual(review.humanReview);
    }
  });
  it('attention query does not exclude registered interactive/local workers', () => {
    const source = readFileSync(new URL('../app/app/(protected)/home/page.tsx', import.meta.url), 'utf8');
    const query = source.slice(source.indexOf('const openPrWorkers ='), source.indexOf('if (openPrWorkers.length'));
    expect(query).toContain('isNotNull(workers.prUrl)');
    expect(query).not.toMatch(/workers\.(runner|executor)|tasks\.executor/);
  });
});

it('a canonical approved reviewer becomes MERGE under approve-only policy', () => {
  expect(card(null, { policyTier: 'agent-review', reviewApproved: true, prLifecycleStatus: 'ci_green' }).chip).toBe('MERGE');
  expect(card(null, { policyTier: 'agent-review', reviewApproved: true, prLifecycleStatus: 'ci_running' }).chip).toBe('CI_RUNNING');
});

it('escalated + green CI + conflict repair keeps the review with conflict detail', () => {
  const item = card(resolveHumanPrReview(base), { prLifecycleStatus: 'ci_green', conflictRetryTaskId: 'repair' });
  expect(item.chip).toBe('REVIEW');
  expect(item.machineStatus).toBe('Conflict repair queued');
});
it('a bot approval or a stale-head approval cannot clear the review action', () => {
  expect(resolveHumanPrReview({ ...base, github: { reviewDecision: null, humanApproved: false } })).not.toBeNull();
});
it('required code-owner approval remains actionable after another human approves', () => {
  expect(resolveHumanPrReview({ ...base, github: { reviewDecision: 'REVIEW_REQUIRED', humanApproved: true } })?.label).toBe('Approve on GitHub');
});
it('request-changes remains machine-owned while a fix is available, without an explicit human escalation', () => {
  const action = resolveHumanPrReview({ ...base, github: { reviewDecision: null, humanApproved: false },
    reviewerTask: { ...escalation, result: { structuredOutput: { verdict: 'request-changes' } } },
    escalationReason: 'Reviewer requested changes' });
  expect(action).toBeNull();
  const item = card(action, { ciGate: { kind: 'fixing', fixKind: 'review', taskId: 'fix' } });
  expect(item.chip).toBe('FIXING_REVIEW');
});

it('a human-approved escalation reaches manual merge after CI, never auto merge', () => {
  const input = { ...base, github: { reviewDecision: 'APPROVED', humanApproved: true } };
  const approved = isCurrentReviewApproved(input);
  expect(approved).toBe(true);
  expect(card(resolveHumanPrReview(input), { policyTier: 'agent-review', reviewApproved: approved, prLifecycleStatus: 'ci_running' }).chip).toBe('CI_RUNNING');
  expect(card(resolveHumanPrReview(input), { policyTier: 'agent-review', reviewApproved: approved, prLifecycleStatus: 'ci_green' }).chip).toBe('MERGE');
  expect(isCurrentReviewApproved({ ...input, github: { reviewDecision: 'REVIEW_REQUIRED', humanApproved: true } })).toBe(false);
  expect(isCurrentReviewApproved({ ...input, github: { reviewDecision: null, humanApproved: false } })).toBe(false);
  expect(isCurrentReviewApproved({ ...input, reviewerTask: { ...escalation, result: { structuredOutput: { verdict: 'request-changes' } } } })).toBe(false);
});

it('Home feeds human approval into manual readiness without enabling automatic merging', () => {
  const source = readFileSync(new URL('../app/app/(protected)/home/page.tsx', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('if (!humanReview && isCurrentReviewApproved'), source.indexOf('const reviewInFlight ='));
  expect(block).toContain('github: githubApprovalByWorkerId.get(w.id)');
  const automatic = block.slice(block.indexOf('reviewApprovedTaskIds.add'));
  expect(automatic).toContain('if (isCurrentReviewApproved({');
  expect(automatic).not.toContain('github:');
});

describe('the human review card leads with one decision', () => {
  const escalated = (output: Record<string, unknown>) => ({
    ...base,
    github: { reviewDecision: null, humanApproved: false },
    reviewerTask: { ...escalation, result: { structuredOutput: { verdict: 'escalate', summary: 'protected migration paths', ...output } } },
  });
  it('drops the label prefix the card already shows', () => {
    const review = resolveHumanPrReview(escalated({ escalationReason: 'Adds a table. Also renames nothing.' }));
    expect(review?.reason).toBe('Adds a table. Also renames nothing.');
    expect(review?.reason).not.toContain('Review required');
  });
  it('the reviewer recommendation is the decision line', () => {
    const review = resolveHumanPrReview(escalated({ escalationReason: 'Adds a table. More detail.', recommendation: 'Approve the additive migration.' }));
    expect(review?.decision).toBe('Approve the additive migration.');
  });
  it("without a recommendation the decision is the reason's first sentence", () => {
    expect(resolveHumanPrReview(escalated({ escalationReason: 'Adds a table. More detail.' }))?.decision).toBe('Adds a table.');
  });
  it('a recommendation from the mission note is used when the row has none', () => {
    expect(resolveHumanPrReview({ ...escalated({ escalationReason: 'Adds a table.' }), recommendation: 'Check the index name.' })?.decision).toBe('Check the index name.');
  });
  it('structured blockers ride along; old rows have none', () => {
    expect(resolveHumanPrReview(escalated({ escalationReason: 'x.', blockers: [{ kind: 'migration', text: 'Adds a table' }] }))?.blockers)
      .toEqual([{ kind: 'migration', text: 'Adds a table' }]);
    expect(resolveHumanPrReview(escalated({ escalationReason: 'x.' }))?.blockers).toEqual([]);
  });
  it('the policy-only case is its own decision', () => {
    const review = resolveHumanPrReview({ ...base, reviewerTask: null, github: null, policyTier: 'human' });
    expect(review?.decision).toBe('Human approval required');
  });
});
