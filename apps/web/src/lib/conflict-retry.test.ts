import { describe, it, expect } from 'bun:test';
import {
  classifyMergeFailure,
  isAutoResolveMergeConflictsEnabled,
  buildConflictRetryTask,
  DEFAULT_MAX_CONFLICT_ITERATIONS,
} from './conflict-retry';
import type { ConflictRetryInput } from './conflict-retry';

// ── classifyMergeFailure ──────────────────────────────────────────────────────

describe('classifyMergeFailure', () => {
  it('classifies explicit conflict messages as conflict', () => {
    expect(classifyMergeFailure('Pull Request has merge conflicts')).toBe('conflict');
    expect(classifyMergeFailure('Merge conflict detected')).toBe('conflict');
    expect(classifyMergeFailure('PR has conflicts (mergeable_state: dirty) — needs rebase onto base branch')).toBe('conflict');
    expect(classifyMergeFailure('needs rebase')).toBe('conflict');
    expect(classifyMergeFailure('unresolvable conflicts')).toBe('conflict');
  });

  it('is case-insensitive', () => {
    expect(classifyMergeFailure('PULL REQUEST HAS MERGE CONFLICTS')).toBe('conflict');
    expect(classifyMergeFailure('Mergeable_State: Dirty')).toBe('conflict');
  });

  it('classifies branch-protection and review-required as blocked', () => {
    expect(classifyMergeFailure('Method Not Allowed')).toBe('blocked');
    expect(classifyMergeFailure('405')).toBe('blocked');
    expect(classifyMergeFailure('branch protection rules prevent merging')).toBe('blocked');
    expect(classifyMergeFailure('required status checks')).toBe('blocked');
    expect(classifyMergeFailure('review required')).toBe('blocked');
    expect(classifyMergeFailure('This PR cannot be merged')).toBe('blocked');
  });

  it('classifies unknown messages as retryable', () => {
    expect(classifyMergeFailure('Internal Server Error')).toBe('retryable');
    expect(classifyMergeFailure('network timeout')).toBe('retryable');
    expect(classifyMergeFailure('')).toBe('retryable');
  });
});

// ── isAutoResolveMergeConflictsEnabled ────────────────────────────────────────

describe('isAutoResolveMergeConflictsEnabled', () => {
  it('returns true when gitConfig is null (default ON)', () => {
    expect(isAutoResolveMergeConflictsEnabled(null)).toBe(true);
  });

  it('returns true when gitConfig is undefined', () => {
    expect(isAutoResolveMergeConflictsEnabled(undefined)).toBe(true);
  });

  it('returns true when autoResolveMergeConflicts is absent from config', () => {
    expect(isAutoResolveMergeConflictsEnabled({} as any)).toBe(true);
  });

  it('returns true when autoResolveMergeConflicts is explicitly true', () => {
    expect(isAutoResolveMergeConflictsEnabled({ autoResolveMergeConflicts: true } as any)).toBe(true);
  });

  it('returns false when autoResolveMergeConflicts is false', () => {
    expect(isAutoResolveMergeConflictsEnabled({ autoResolveMergeConflicts: false } as any)).toBe(false);
  });
});

// ── buildConflictRetryTask ────────────────────────────────────────────────────

function makeInput(overrides?: Partial<ConflictRetryInput>): ConflictRetryInput {
  return {
    originalTask: {
      id: 'task-abc',
      title: 'feat: add dark mode',
      description: 'Implement dark mode for the dashboard.',
      workspaceId: 'ws-1',
      context: null,
      missionId: 'mission-1',
    },
    worker: {
      id: 'worker-xyz',
      branch: 'feat/dark-mode',
      prNumber: 42,
    },
    headSha: 'abc123def456',
    repoFullName: 'acme/app',
    ...overrides,
  };
}

describe('buildConflictRetryTask', () => {
  it('returns a retry task on the first iteration', () => {
    const result = buildConflictRetryTask(makeInput());
    expect(result).not.toBeNull();
    expect(result!.title).toBe('[Conflict Retry #1] feat: add dark mode');
    expect(result!.creationSource).toBe('conflict');
    expect(result!.conflictRetryPrNumber).toBe(42);
    expect(result!.conflictRetryHeadSha).toBe('abc123def456');
    expect(result!.context.conflictIteration).toBe(1);
    expect(result!.context.maxConflictIterations).toBe(DEFAULT_MAX_CONFLICT_ITERATIONS);
  });

  it('increments iteration from task context', () => {
    const input = makeInput({
      originalTask: {
        id: 'task-abc',
        title: 'feat: add dark mode',
        description: null,
        workspaceId: 'ws-1',
        context: { conflictIteration: 1 },
        missionId: null,
      },
    });
    const result = buildConflictRetryTask(input);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('[Conflict Retry #2] feat: add dark mode');
    expect(result!.context.conflictIteration).toBe(2);
  });

  it('returns null when iteration cap is reached (default 3)', () => {
    const input = makeInput({
      originalTask: {
        id: 'task-abc',
        title: 'feat: add dark mode',
        description: null,
        workspaceId: 'ws-1',
        context: { conflictIteration: 3 },
        missionId: null,
      },
    });
    expect(buildConflictRetryTask(input)).toBeNull();
  });

  it('returns null when maxConflictIterations is 0', () => {
    expect(buildConflictRetryTask(makeInput({ maxConflictIterations: 0 }))).toBeNull();
  });

  it('respects a custom maxConflictIterations override', () => {
    const input = makeInput({
      maxConflictIterations: 5,
      originalTask: {
        id: 'task-abc',
        title: 'feat: add dark mode',
        description: null,
        workspaceId: 'ws-1',
        context: { conflictIteration: 4 },
        missionId: null,
      },
    });
    const result = buildConflictRetryTask(input);
    expect(result).not.toBeNull();
    expect(result!.context.conflictIteration).toBe(5);
    expect(result!.context.maxConflictIterations).toBe(5);
  });

  it('strips existing [Conflict Retry #N] prefix from title', () => {
    const input = makeInput({
      originalTask: {
        id: 'task-abc',
        title: '[Conflict Retry #1] feat: add dark mode',
        description: null,
        workspaceId: 'ws-1',
        context: { conflictIteration: 1 },
        missionId: null,
      },
    });
    const result = buildConflictRetryTask(input);
    expect(result!.title).toBe('[Conflict Retry #2] feat: add dark mode');
  });

  it('strips existing [CI Retry #N] prefix from title', () => {
    const input = makeInput({
      originalTask: {
        id: 'task-abc',
        title: '[CI Retry #2] feat: add dark mode',
        description: null,
        workspaceId: 'ws-1',
        context: null,
        missionId: null,
      },
    });
    const result = buildConflictRetryTask(input);
    expect(result!.title).toBe('[Conflict Retry #1] feat: add dark mode');
  });

  it('sets branch continuity fields in context', () => {
    const result = buildConflictRetryTask(makeInput());
    expect(result!.context.baseBranch).toBe('feat/dark-mode');
    expect(result!.context.resumeBranch).toBe('feat/dark-mode');
    expect((result!.context.failureContext as any).errorType).toBe('merge_conflict');
    expect((result!.context.failureContext as any).prNumber).toBe(42);
  });

  it('passes through skillSlugs and verificationCommand from original context', () => {
    const input = makeInput({
      originalTask: {
        id: 'task-abc',
        title: 'feat: add dark mode',
        description: null,
        workspaceId: 'ws-1',
        context: { skillSlugs: ['builder'], verificationCommand: 'bun test' },
        missionId: null,
      },
    });
    const result = buildConflictRetryTask(input);
    expect(result!.context.skillSlugs).toEqual(['builder']);
    expect(result!.context.verificationCommand).toBe('bun test');
  });

  it('propagates missionId from original task', () => {
    const result = buildConflictRetryTask(makeInput());
    expect(result!.missionId).toBe('mission-1');
  });

  it('includes the PR URL in the description', () => {
    const result = buildConflictRetryTask(makeInput());
    expect(result!.description).toContain('https://github.com/acme/app/pull/42');
    expect(result!.description).toContain('Attempt 1 of 3');
  });
});
