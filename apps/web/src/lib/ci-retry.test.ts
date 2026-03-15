import { describe, it, expect } from 'bun:test';
import { buildCIRetryTask, type CIRetryParams } from './ci-retry';

function makeParams(overrides: Partial<CIRetryParams> = {}): CIRetryParams {
  return {
    originalTask: {
      id: 'task-1',
      title: 'Fix the login bug',
      description: 'The login form crashes on submit',
      workspaceId: 'ws-1',
      context: {},
      objectiveId: null,
    },
    worker: {
      id: 'worker-1',
      branch: 'buildd/task-1-fix-login',
      prNumber: 42,
    },
    failureContext: 'Build failed: type error in auth.ts',
    repoFullName: 'test-org/test-repo',
    ...overrides,
  };
}

describe('buildCIRetryTask', () => {
  it('creates a retry task with correct title and metadata', () => {
    const result = buildCIRetryTask(makeParams());

    expect(result).not.toBeNull();
    expect(result!.title).toBe('[CI Retry #1] Fix the login bug');
    expect(result!.workspaceId).toBe('ws-1');
    expect(result!.parentTaskId).toBe('task-1');
    expect(result!.creationSource).toBe('webhook');
    expect(result!.context.iteration).toBe(1);
    expect(result!.context.maxIterations).toBe(3);
    expect(result!.context.baseBranch).toBe('buildd/task-1-fix-login');
    expect(result!.context.prNumber).toBe(42);
    expect(result!.context.failureContext).toBe('Build failed: type error in auth.ts');
  });

  it('strips existing retry prefix from title', () => {
    const result = buildCIRetryTask(makeParams({
      originalTask: {
        id: 'task-1',
        title: '[CI Retry #1] Fix the login bug',
        description: null,
        workspaceId: 'ws-1',
        context: { iteration: 1 },
      },
    }));

    expect(result!.title).toBe('[CI Retry #2] Fix the login bug');
    expect(result!.context.iteration).toBe(2);
  });

  it('returns null when max iterations reached (default 3)', () => {
    const result = buildCIRetryTask(makeParams({
      originalTask: {
        id: 'task-1',
        title: 'Fix bug',
        description: null,
        workspaceId: 'ws-1',
        context: { iteration: 3, maxIterations: 3 },
      },
    }));

    expect(result).toBeNull();
  });

  it('respects workspace-level maxCiRetries over task context', () => {
    // Task context says maxIterations=3, but workspace says maxCiRetries=5
    const result = buildCIRetryTask(makeParams({
      originalTask: {
        id: 'task-1',
        title: 'Fix bug',
        description: null,
        workspaceId: 'ws-1',
        context: { iteration: 3, maxIterations: 3 },
      },
      workspaceMaxCiRetries: 5,
    }));

    expect(result).not.toBeNull();
    expect(result!.context.iteration).toBe(4);
    expect(result!.context.maxIterations).toBe(5);
  });

  it('returns null when workspace maxCiRetries is 0 (disabled)', () => {
    const result = buildCIRetryTask(makeParams({
      workspaceMaxCiRetries: 0,
    }));

    expect(result).toBeNull();
  });

  it('inherits objectiveId from original task', () => {
    const result = buildCIRetryTask(makeParams({
      originalTask: {
        id: 'task-1',
        title: 'Fix bug',
        description: null,
        workspaceId: 'ws-1',
        context: {},
        objectiveId: 'obj-123',
      },
    }));

    expect(result!.objectiveId).toBe('obj-123');
  });

  it('sets objectiveId to null when original has none', () => {
    const result = buildCIRetryTask(makeParams());

    expect(result!.objectiveId).toBeNull();
  });

  it('preserves verificationCommand from original context', () => {
    const result = buildCIRetryTask(makeParams({
      originalTask: {
        id: 'task-1',
        title: 'Fix bug',
        description: null,
        workspaceId: 'ws-1',
        context: { verificationCommand: 'bun test && bun run build' },
      },
    }));

    expect(result!.context.verificationCommand).toBe('bun test && bun run build');
  });

  it('preserves skillSlugs from original context', () => {
    const result = buildCIRetryTask(makeParams({
      originalTask: {
        id: 'task-1',
        title: 'Fix bug',
        description: null,
        workspaceId: 'ws-1',
        context: { skillSlugs: ['ralph-loop', 'buildd-workflow'] },
      },
    }));

    expect(result!.context.skillSlugs).toEqual(['ralph-loop', 'buildd-workflow']);
  });

  it('handles null worker prNumber', () => {
    const result = buildCIRetryTask(makeParams({
      worker: {
        id: 'worker-1',
        branch: 'buildd/task-1-fix-login',
        prNumber: null,
      },
    }));

    expect(result!.context.prNumber).toBeUndefined();
  });

  it('uses default maxIterations of 3 when not specified', () => {
    const result = buildCIRetryTask(makeParams({
      originalTask: {
        id: 'task-1',
        title: 'Fix bug',
        description: null,
        workspaceId: 'ws-1',
        context: null,
      },
    }));

    expect(result!.context.maxIterations).toBe(3);
    expect(result!.context.iteration).toBe(1);
  });

  it('includes description with CI failure output and instructions', () => {
    const result = buildCIRetryTask(makeParams());

    expect(result!.description).toContain('CI checks failed');
    expect(result!.description).toContain('Build failed: type error in auth.ts');
    expect(result!.description).toContain('Attempt 1 of 3');
    expect(result!.description).toContain('## Instructions');
    expect(result!.description).toContain('## Original Task Description');
    expect(result!.description).toContain('The login form crashes on submit');
  });

  it('omits original description section when description is null', () => {
    const result = buildCIRetryTask(makeParams({
      originalTask: {
        id: 'task-1',
        title: 'Fix bug',
        description: null,
        workspaceId: 'ws-1',
        context: {},
      },
    }));

    expect(result!.description).not.toContain('## Original Task Description');
  });
});
