import { describe, expect, it, mock } from 'bun:test';

mock.module('@/lib/github', () => ({ githubApi: mock(async () => { throw new Error('live GitHub not used in tests'); }) }));

const { isReviewerTaskContext, publishReviewBudgetWait } = await import('./review-budget-wait');

describe('a review held by a usage wall', () => {
  const ctx = { reviewerFor: 'orig-task', repoFullName: 'acme/app', headSha: 'abc1234def', installationId: 42, prNumber: 7 };

  it('publishes Review approval as pending with the cause and the resume time', async () => {
    const calls: any[] = [];
    const wrote = await publishReviewBudgetWait(
      { context: ctx, resetsAt: new Date('2026-11-14T16:00:00Z') },
      { api: async (...a) => { calls.push(a); return {}; } },
    );
    expect(wrote).toBe(true);
    expect(calls).toHaveLength(1);
    const [installationId, path, init] = calls[0];
    expect(installationId).toBe(42);
    expect(path).toBe('/repos/acme/app/statuses/abc1234def');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      state: 'pending',
      context: 'Buildd / Review approval',
      description: 'Review waiting for model budget: resumes 16:00 UTC',
    });
    // Never a failure, never a human-decision request.
    expect(body.description).not.toMatch(/unavailable|person has to decide|blocked/i);
  });

  it('writes nothing for a reviewer context without repo, head or installation', async () => {
    const api = mock(async () => ({}));
    expect(await publishReviewBudgetWait({ context: { reviewerFor: 'x' }, resetsAt: new Date() }, { api })).toBe(false);
    expect(api).not.toHaveBeenCalled();
  });

  it('recognises a reviewer task by its context', () => {
    expect(isReviewerTaskContext(ctx)).toBe(true);
    expect(isReviewerTaskContext({})).toBe(false);
    expect(isReviewerTaskContext(null)).toBe(false);
  });
});
