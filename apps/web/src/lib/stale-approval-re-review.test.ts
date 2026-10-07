import { describe, expect, it, mock } from 'bun:test';
import {
  dispatchStaleApprovalReReview,
  type StaleApprovalReReviewDeps,
  type StaleApprovalReReviewInput,
} from './stale-approval-re-review';

const HEAD = 'b'.repeat(40);
const PRIOR = 'a'.repeat(40);

const input: StaleApprovalReReviewInput = {
  workspaceId: 'ws-1',
  installationId: 7,
  repoFullName: 'buildd-ai/buildd',
  prNumber: 42,
  headSha: HEAD,
  baseRef: 'dev',
  taskId: 'task-1',
  workerId: 'worker-1',
  policy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer', maxConfidenceThreshold: 0.8 } } as never,
};

const priorVerdict = { headSha: PRIOR, verdict: 'approve' as const, confidence: 0.9, summary: 'looks good' };

function deps(over: Partial<StaleApprovalReReviewDeps> = {}): StaleApprovalReReviewDeps & {
  createReviewerTask: ReturnType<typeof mock>;
  announceTaskCreated: ReturnType<typeof mock>;
  wakeTask: ReturnType<typeof mock>;
  appendPrActivity: ReturnType<typeof mock>;
} {
  return {
    resolvePlan: mock(async () => ({ kind: 'delta', priorVerdict }) as const),
    loadContext: mock(async () => ({
      workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null },
      task: { id: 'task-1', title: 'fix a thing', description: null, backend: 'claude' as const, missionId: 'm-1', pathManifest: null, context: {} },
      worker: { branch: 'buildd/task-1', prUrl: 'https://github.com/buildd-ai/buildd/pull/42' },
    })),
    listRoles: mock(async () => [{ slug: 'reviewer', isRole: true }]),
    createReviewerTask: mock(async () => ({ id: 'review-2' })),
    announceTaskCreated: mock(async () => {}),
    wakeTask: mock(async () => {}),
    appendPrActivity: mock(async () => {}),
    ...over,
  } as never;
}

describe('dispatchStaleApprovalReReview', () => {
  it('dispatches a DELTA review against the prior approval when the diff changed', async () => {
    const d = deps();
    const res = await dispatchStaleApprovalReReview(input, d);
    expect(res).toEqual({ outcome: 'dispatched', reviewTaskId: 'review-2', plan: 'delta' });
    const created = (d.createReviewerTask.mock.calls[0] as any[])[0];
    expect(created).toMatchObject({
      workspaceId: 'ws-1',
      originalTaskId: 'task-1',
      prNumber: 42,
      headSha: HEAD,
      reviewerRole: 'reviewer',
      baseRef: 'dev',
      priorVerdict,
    });
    expect(d.announceTaskCreated).toHaveBeenCalledTimes(1);
    expect(d.wakeTask).toHaveBeenCalledWith('review-2', 'task.created');
    expect(d.appendPrActivity).toHaveBeenCalledTimes(1);
  });

  it('is single-flight: a reviewer already working the PR is not stacked', async () => {
    const d = deps({ resolvePlan: mock(async () => ({ kind: 'in_flight', reviewTaskId: 'review-live' }) as const) });
    const res = await dispatchStaleApprovalReReview(input, d);
    expect(res).toEqual({ outcome: 'already_reviewing', reviewTaskId: 'review-live' });
    expect(d.createReviewerTask).not.toHaveBeenCalled();
    expect(d.wakeTask).not.toHaveBeenCalled();
  });

  it('is single-flight per head: a deduplicated reviewer for this head is not dispatched again', async () => {
    const d = deps({ createReviewerTask: mock(async () => ({ id: 'review-same-head', deduplicated: true as const })) });
    const res = await dispatchStaleApprovalReReview(input, d);
    expect(res).toEqual({ outcome: 'already_reviewing', reviewTaskId: 'review-same-head' });
    expect(d.wakeTask).not.toHaveBeenCalled();
  });

  it('sends a full review when no prior verdict is usable', async () => {
    const d = deps({ resolvePlan: mock(async () => ({ kind: 'full' }) as const) });
    const res = await dispatchStaleApprovalReReview(input, d);
    expect(res).toMatchObject({ outcome: 'dispatched', plan: 'full' });
    const created = (d.createReviewerTask.mock.calls[0] as any[])[0];
    expect(created.priorVerdict).toBeUndefined();
  });

  it('a first review of a never-reviewed PR is labelled as a request, not as a stale approval', async () => {
    const d = deps({ resolvePlan: mock(async () => ({ kind: 'full' }) as const) });
    const res = await dispatchStaleApprovalReReview({ ...input, firstReview: true }, d);
    expect(res).toMatchObject({ outcome: 'dispatched', plan: 'full' });
    const activity = (d.appendPrActivity.mock.calls[0] as any[])[0];
    expect(activity.entry).toEqual({ kind: 'review_queued', detail: 'review requested · the PR was ready and no review was on file' });
  });

  it('skips with a reason when no task owns the PR', async () => {
    const d = deps();
    const res = await dispatchStaleApprovalReReview({ ...input, taskId: null }, d);
    expect(res.outcome).toBe('skipped');
    expect(d.createReviewerTask).not.toHaveBeenCalled();
  });

  it('skips with a reason when the workspace has no reviewer role', async () => {
    const d = deps({ listRoles: mock(async () => []) });
    const res = await dispatchStaleApprovalReReview(input, d);
    expect(res.outcome).toBe('skipped');
    expect(d.createReviewerTask).not.toHaveBeenCalled();
  });

  it('never throws: a failing read resolves to skipped', async () => {
    const d = deps({ resolvePlan: mock(async () => { throw new Error('db down'); }) });
    const res = await dispatchStaleApprovalReReview(input, d);
    expect(res).toMatchObject({ outcome: 'skipped' });
    expect((res as { reason: string }).reason).toContain('db down');
  });
});
