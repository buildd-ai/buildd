import { describe, it, expect } from 'bun:test';
import { buildCIRetryTask } from '../ci-retry';

describe('buildCIRetryTask', () => {
  const baseParams = {
    originalTask: {
      id: 'task-original-123',
      title: 'feat: add user auth',
      description: 'Implement user authentication',
      workspaceId: 'ws-1',
      context: {
        verificationCommand: 'bun test && bun run build',
        iteration: 1,
        maxIterations: 5,
      } as Record<string, unknown>,
    },
    worker: {
      id: 'worker-1',
      branch: 'buildd/abc12345-add-user-auth',
      prNumber: 42,
    },
    failureContext: 'CI failed: TypeScript errors in auth.ts line 42',
    repoFullName: 'buildd-ai/buildd',
  };

  it('creates a retry task with correct parentTaskId', () => {
    const result = buildCIRetryTask(baseParams);
    expect(result.parentTaskId).toBe('task-original-123');
  });

  it('sets baseBranch to the previous worker branch', () => {
    const result = buildCIRetryTask(baseParams);
    expect(result.context.baseBranch).toBe('buildd/abc12345-add-user-auth');
  });

  it('increments iteration count', () => {
    const result = buildCIRetryTask(baseParams);
    expect(result.context.iteration).toBe(2);
  });

  it('starts at iteration 1 when no previous iteration', () => {
    const params = {
      ...baseParams,
      originalTask: {
        ...baseParams.originalTask,
        context: {} as Record<string, unknown>,
      },
    };
    const result = buildCIRetryTask(params);
    expect(result.context.iteration).toBe(1);
  });

  it('preserves maxIterations from original task', () => {
    const result = buildCIRetryTask(baseParams);
    expect(result.context.maxIterations).toBe(5);
  });

  it('includes failure context', () => {
    const result = buildCIRetryTask(baseParams);
    expect(result.context.failureContext).toBe('CI failed: TypeScript errors in auth.ts line 42');
  });

  it('preserves verificationCommand', () => {
    const result = buildCIRetryTask(baseParams);
    expect(result.context.verificationCommand).toBe('bun test && bun run build');
  });

  it('sets title with retry prefix', () => {
    const result = buildCIRetryTask(baseParams);
    expect(result.title).toContain('[CI Retry');
    expect(result.title).toContain('add user auth');
  });

  it('sets description with failure details', () => {
    const result = buildCIRetryTask(baseParams);
    expect(result.description).toContain('CI failed');
    expect(result.description).toContain('TypeScript errors');
  });

  it('sets workspaceId from original task', () => {
    const result = buildCIRetryTask(baseParams);
    expect(result.workspaceId).toBe('ws-1');
  });

  it('sets creationSource to webhook', () => {
    const result = buildCIRetryTask(baseParams);
    expect(result.creationSource).toBe('webhook');
  });

  it('returns null when maxIterations exceeded', () => {
    const params = {
      ...baseParams,
      originalTask: {
        ...baseParams.originalTask,
        context: {
          iteration: 5,
          maxIterations: 5,
        } as Record<string, unknown>,
      },
    };
    const result = buildCIRetryTask(params);
    expect(result).toBeNull();
  });

  it('defaults maxIterations to 3 when not set', () => {
    const params = {
      ...baseParams,
      originalTask: {
        ...baseParams.originalTask,
        context: {} as Record<string, unknown>,
      },
    };
    const result = buildCIRetryTask(params);
    expect(result!.context.maxIterations).toBe(3);
  });

  it('includes PR number in context', () => {
    const result = buildCIRetryTask(baseParams);
    expect(result!.context.prNumber).toBe(42);
  });
});
