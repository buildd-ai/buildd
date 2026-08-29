import { describe, it, expect } from 'bun:test';
import { deriveStage } from './StageChip';

describe('deriveStage — completed task + PR state', () => {
  it('returns OPEN for a completed task with an open PR and no mergedAt', () => {
    expect(deriveStage({
      taskStatus: 'completed',
      prUrl: 'https://github.com/org/repo/pull/1',
      prLifecycleStatus: null,
      mergedAt: null,
    })).toBe('OPEN');
  });

  it('returns OPEN when prLifecycleStatus is pr_open', () => {
    expect(deriveStage({
      taskStatus: 'completed',
      prUrl: 'https://github.com/org/repo/pull/1',
      prLifecycleStatus: 'pr_open',
      mergedAt: null,
    })).toBe('OPEN');
  });

  it('returns DONE when mergedAt is set', () => {
    expect(deriveStage({
      taskStatus: 'completed',
      prUrl: 'https://github.com/org/repo/pull/1',
      prLifecycleStatus: 'pr_open',
      mergedAt: new Date().toISOString(),
    })).toBe('DONE');
  });

  it('returns DONE when prLifecycleStatus is merged', () => {
    expect(deriveStage({
      taskStatus: 'completed',
      prUrl: 'https://github.com/org/repo/pull/1',
      prLifecycleStatus: 'merged',
      mergedAt: null,
    })).toBe('DONE');
  });

  it('returns DONE when prLifecycleStatus is closed', () => {
    expect(deriveStage({
      taskStatus: 'completed',
      prUrl: 'https://github.com/org/repo/pull/1',
      prLifecycleStatus: 'closed',
      mergedAt: null,
    })).toBe('DONE');
  });

  it('returns CI when prLifecycleStatus is ci_running', () => {
    expect(deriveStage({
      taskStatus: 'completed',
      prUrl: 'https://github.com/org/repo/pull/1',
      prLifecycleStatus: 'ci_running',
      mergedAt: null,
    })).toBe('CI');
  });

  it('returns DONE for a completed task with no PR', () => {
    expect(deriveStage({
      taskStatus: 'completed',
      prUrl: null,
    })).toBe('DONE');
  });

  it('returns FAILED for a failed task', () => {
    expect(deriveStage({
      taskStatus: 'failed',
      prUrl: 'https://github.com/org/repo/pull/1',
      prLifecycleStatus: 'merged',
      mergedAt: new Date().toISOString(),
    })).toBe('FAILED');
  });

  it('returns CANCELLED for a cancelled task', () => {
    expect(deriveStage({ taskStatus: 'cancelled' })).toBe('CANCELLED');
  });

  it('returns RUNNING when worker is running', () => {
    expect(deriveStage({
      taskStatus: 'in_progress',
      workerStatus: 'running',
      prUrl: null,
    })).toBe('RUNNING');
  });

  it('returns WAITING_INPUT when worker is waiting_input', () => {
    expect(deriveStage({
      taskStatus: 'in_progress',
      workerStatus: 'waiting_input',
    })).toBe('WAITING_INPUT');
  });
});
