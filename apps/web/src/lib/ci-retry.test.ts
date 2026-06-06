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
    expect(t!.context.failureContext).toBe('Job "test" failed');
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
});
