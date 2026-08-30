import { describe, it, expect } from 'bun:test';
import { buildCIRetryTask } from './ci-retry';

const baseParams = {
  originalTask: {
    id: 't1',
    title: 'Fix the parser',
    description: 'orig',
    workspaceId: 'ws1',
    context: {} as Record<string, unknown>,
    missionId: 'm1',
  },
  worker: { id: 'w1', branch: 'buildd/abc-fix', prNumber: 42 },
  failureContext: 'Job "test" failed',
  repoFullName: 'org/repo',
};

describe('buildCIRetryTask', () => {
  it('builds the first retry (iteration 0 → 1) with branch + mission continuity', () => {
    const t = buildCIRetryTask(baseParams);
    expect(t).not.toBeNull();
    expect(t!.title).toBe('[CI Retry #1] Fix the parser');
    expect(t!.parentTaskId).toBe('t1');
    expect(t!.missionId).toBe('m1');
    expect(t!.creationSource).toBe('webhook');
    expect(t!.context.iteration).toBe(1);
    expect(t!.context.maxIterations).toBe(3);
    expect(t!.context.baseBranch).toBe('buildd/abc-fix');
    expect(t!.context.prNumber).toBe(42);
    // failureContext is now a structured object, not a bare string
    expect((t!.context.failureContext as any).summary).toBe('Job "test" failed');
  });

  it('does not double-prefix the title on subsequent retries', () => {
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, title: '[CI Retry #1] Fix the parser', context: { iteration: 1 } },
    });
    expect(t!.title).toBe('[CI Retry #2] Fix the parser');
    expect(t!.context.iteration).toBe(2);
  });

  it('returns null when retries are exhausted (iteration >= max)', () => {
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: { iteration: 3 } },
    });
    expect(t).toBeNull();
  });

  it('returns null when maxCiRetries is 0 (disabled)', () => {
    const t = buildCIRetryTask({ ...baseParams, workspaceMaxCiRetries: 0 });
    expect(t).toBeNull();
  });

  it('workspace maxCiRetries overrides task-level maxIterations', () => {
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: { iteration: 1, maxIterations: 2 } },
      workspaceMaxCiRetries: 5,
    });
    expect(t!.context.maxIterations).toBe(5);
    expect(t!.context.iteration).toBe(2);
  });

  it('embeds a scoped `gh run view --log-failed` command when a run id is provided', () => {
    const t = buildCIRetryTask({ ...baseParams, ciRunId: 12345, ciRunUrl: 'https://github.com/org/repo/actions/runs/12345' });
    expect(t!.description).toContain('gh run view 12345 --repo org/repo --log-failed');
    expect(t!.description).toContain('failed steps only');
    expect(t!.context.ciRunId).toBe(12345);
    expect(t!.context.ciRunUrl).toBe('https://github.com/org/repo/actions/runs/12345');
  });

  it('omits the gh log section when no run id is available', () => {
    const t = buildCIRetryTask(baseParams);
    expect(t!.description).not.toContain('gh run view');
    expect(t!.context.ciRunId).toBeUndefined();
  });

  it('preserves verificationCommand and skillSlugs from the original task', () => {
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: { verificationCommand: 'bun test', skillSlugs: ['x'] } },
    });
    expect(t!.context.verificationCommand).toBe('bun test');
    expect(t!.context.skillSlugs).toEqual(['x']);
  });

  // Spec §6.3 — retry-continuity fields
  it('sets context.resumeBranch equal to worker.branch', () => {
    const t = buildCIRetryTask(baseParams);
    expect(t!.context.resumeBranch).toBe('buildd/abc-fix');
  });

  it('still sets context.baseBranch for backward compat', () => {
    const t = buildCIRetryTask(baseParams);
    expect(t!.context.baseBranch).toBe('buildd/abc-fix');
  });

  it('sets context.failureContext as a RetryFailureContext object with errorType ci_failure', () => {
    const t = buildCIRetryTask(baseParams);
    expect(typeof t!.context.failureContext).toBe('object');
    const fc = t!.context.failureContext as any;
    expect(fc.summary).toBe('Job "test" failed');
    expect(fc.errorType).toBe('ci_failure');
  });

  it('copies context.lastCommitSha from parent task context when present', () => {
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: { lastCommitSha: 'abc123sha' } },
    });
    expect(t!.context.lastCommitSha).toBe('abc123sha');
  });

  it('includes commitSha in failureContext when parent context has lastCommitSha', () => {
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: { lastCommitSha: 'abc123sha' } },
    });
    const fc = t!.context.failureContext as any;
    expect(fc.commitSha).toBe('abc123sha');
  });

  it('omits lastCommitSha from context when parent context lacks it', () => {
    const t = buildCIRetryTask(baseParams);
    expect(t!.context.lastCommitSha).toBeUndefined();
  });

  // ── Foreign-commit / non-worker-authored SHA ─────────────────────────────

  it('foreign commit: creates retry task without incrementing iteration', () => {
    const t = buildCIRetryTask({ ...baseParams, foreignHeadSha: true, foreignCommitAuthor: 'maxjacu' });
    expect(t).not.toBeNull();
    // iteration must NOT advance — the agent's budget is preserved
    expect(t!.context.iteration).toBe(0);
    expect(t!.context.foreign_head_sha).toBe(true);
    expect(t!.context.foreignCommitAuthor).toBe('maxjacu');
  });

  it('foreign commit: display title still uses currentIteration + 1 for readability', () => {
    const t = buildCIRetryTask({ ...baseParams, foreignHeadSha: true });
    expect(t!.title).toBe('[CI Retry #1] Fix the parser');
  });

  it('foreign commit: description notes the non-worker push and budget preservation', () => {
    const t = buildCIRetryTask({ ...baseParams, foreignHeadSha: true, foreignCommitAuthor: 'maxjacu' });
    expect(t!.description).toContain('not consumed');
    expect(t!.description).toContain('@maxjacu');
  });

  it('three consecutive foreign pushes do not exhaust the retry budget', () => {
    // Each foreign push keeps iteration at its current value; agent always retains full quota.
    let ctx: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) {
      const t = buildCIRetryTask({
        ...baseParams,
        originalTask: { ...baseParams.originalTask, context: ctx },
        foreignHeadSha: true,
        foreignCommitAuthor: 'maxjacu',
      });
      expect(t).not.toBeNull();
      // iteration must stay at 0 after every foreign push
      expect(t!.context.iteration).toBe(0);
      ctx = t!.context; // carry forward for next iteration
    }
  });

  it('mixed chain (worker, outsider, worker): exactly 2 agent attempts counted', () => {
    // Attempt 1: worker fails → iteration 0 → 1
    const t1 = buildCIRetryTask({ ...baseParams, foreignHeadSha: false });
    expect(t1!.context.iteration).toBe(1);

    // Outsider push at iteration 1 → iteration stays 1
    const t2 = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: t1!.context },
      foreignHeadSha: true,
    });
    expect(t2!.context.iteration).toBe(1);

    // Attempt 2: worker fails → iteration 1 → 2
    const t3 = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: t2!.context },
      foreignHeadSha: false,
    });
    expect(t3!.context.iteration).toBe(2);
  });

  it('foreign commit at max iterations: still creates a retry task (budget not consumed)', () => {
    // Iteration is already at max due to genuine agent failures, but this SHA is foreign.
    // Foreign commits bypass the exhaustion cap — the PR needs to get fixed regardless.
    const t = buildCIRetryTask({
      ...baseParams,
      originalTask: { ...baseParams.originalTask, context: { iteration: 3 } },
      workspaceMaxCiRetries: 3,
      foreignHeadSha: true,
    });
    expect(t).not.toBeNull();
    expect(t!.context.iteration).toBe(3); // still 3, not 4
    expect(t!.context.foreign_head_sha).toBe(true);
  });

  it('foreign commit when retries disabled (maxCiRetries=0): returns null — retries off globally', () => {
    const t = buildCIRetryTask({ ...baseParams, workspaceMaxCiRetries: 0, foreignHeadSha: true });
    expect(t).toBeNull();
  });

  it('foreign commit with no author: omits foreignCommitAuthor from context', () => {
    const t = buildCIRetryTask({ ...baseParams, foreignHeadSha: true });
    expect(t!.context.foreign_head_sha).toBe(true);
    expect(t!.context.foreignCommitAuthor).toBeUndefined();
  });
});
