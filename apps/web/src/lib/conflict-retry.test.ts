import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── DB mock setup (hoisted before imports) ────────────────────────────────────

const mockTaskFindFirst = mock(() => Promise.resolve(null) as any);
const mockWorkerFindFirst = mock(() => Promise.resolve(null) as any);
const mockWorkspaceFindFirst = mock(() => Promise.resolve(null) as any);
const mockTaskFindMany = mock(() => Promise.resolve([]) as any);
let capturedInsertValues: any = null;
const mockInsertReturning = mock(() => Promise.resolve([{ id: 'new-task-id' }]) as any);
const mockInsertOnConflict = mock(() => ({ returning: mockInsertReturning }));
const mockInsertValues = mock((vals: any) => {
  capturedInsertValues = vals;
  return { onConflictDoNothing: mockInsertOnConflict };
});
const mockInsert = mock(() => ({ values: mockInsertValues }));

const mockDispatchNewTask = mock(() => Promise.resolve());

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findFirst: (...args: any[]) => mockTaskFindFirst(...args),
        findMany: (...args: any[]) => mockTaskFindMany(...args),
      },
      workers: { findFirst: (...args: any[]) => mockWorkerFindFirst(...args) },
      workspaces: { findFirst: (...args: any[]) => mockWorkspaceFindFirst(...args) },
    },
    insert: (...args: any[]) => mockInsert(...args),
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: 'tasks',
  workers: 'workers',
  workspaces: 'workspaces',
}));

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => args,
  and: (...args: any[]) => args,
  inArray: (...args: any[]) => args,
  isNotNull: (field: any) => ({ isNotNull: field }),
}));

// Keep real path-overlap for meaningful overlap tests
mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

import {
  classifyMergeFailure,
  isAutoResolveMergeConflictsEnabled,
  buildConflictRetryTask,
  dispatchConflictRetry,
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

  describe('pathManifest derivation', () => {
    it("inherits the original task's pathManifest when present", () => {
      const input = makeInput({
        originalTask: {
          id: 'task-abc',
          title: 'feat: add dark mode',
          description: null,
          workspaceId: 'ws-1',
          context: null,
          missionId: 'mission-1',
          pathManifest: ['apps/web/src/**', 'packages/core/**'],
        },
      });
      const result = buildConflictRetryTask(input);
      expect(result!.pathManifest).toEqual(['apps/web/src/**', 'packages/core/**']);
    });

    it("defaults to ['**'] for mission tasks without a pathManifest", () => {
      const result = buildConflictRetryTask(makeInput());
      expect(result!.pathManifest).toEqual(['**']);
    });

    it('returns null pathManifest for standalone tasks without a pathManifest', () => {
      const input = makeInput({
        originalTask: {
          id: 'task-abc',
          title: 'feat: add dark mode',
          description: null,
          workspaceId: 'ws-1',
          context: null,
          missionId: null,
          pathManifest: null,
        },
      });
      const result = buildConflictRetryTask(input);
      expect(result!.pathManifest).toBeNull();
    });
  });
});

// ── dispatchConflictRetry ─────────────────────────────────────────────────────

const BASE_PARAMS = {
  workerId: 'worker-id',
  taskId: 'task-id',
  prNumber: 99,
  headSha: 'sha-abc123',
  repoFullName: 'acme/app',
  workspaceId: 'ws-1',
};

const MOCK_WORKSPACE = { id: 'ws-1', gitConfig: null };
const MOCK_TASK = {
  id: 'task-id',
  title: 'feat: some feature',
  description: 'Do the thing.',
  workspaceId: 'ws-1',
  context: null,
  missionId: 'mission-1',
  parentTaskId: null,
  pathManifest: null,
};
const MOCK_WORKER = { id: 'worker-id', branch: 'buildd/task-id-some-feature', prNumber: 99 };

describe('dispatchConflictRetry', () => {
  beforeEach(() => {
    capturedInsertValues = null;
    mockTaskFindFirst.mockReset();
    mockWorkerFindFirst.mockReset();
    mockWorkspaceFindFirst.mockReset();
    mockTaskFindMany.mockReset();
    mockInsert.mockReset();
    mockInsertValues.mockReset();
    mockInsertOnConflict.mockReset();
    mockInsertReturning.mockReset();
    mockDispatchNewTask.mockReset();

    mockWorkspaceFindFirst.mockResolvedValue(MOCK_WORKSPACE);
    mockTaskFindFirst.mockResolvedValue(MOCK_TASK);
    mockWorkerFindFirst.mockResolvedValue(MOCK_WORKER);
    mockTaskFindMany.mockResolvedValue([]);

    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockImplementation((vals: any) => {
      capturedInsertValues = vals;
      return { onConflictDoNothing: mockInsertOnConflict };
    });
    mockInsertOnConflict.mockReturnValue({ returning: mockInsertReturning });
    mockInsertReturning.mockResolvedValue([{ id: 'new-task-id', ...capturedInsertValues }]);
    mockDispatchNewTask.mockResolvedValue(undefined);
  });

  it('sets subjectAnchor fields on the inserted task', async () => {
    const result = await dispatchConflictRetry(BASE_PARAMS);

    expect(result.dispatched).toBe(true);
    expect(capturedInsertValues).not.toBeNull();
    expect(capturedInsertValues.subjectKind).toBe('pull_request');
    expect(capturedInsertValues.subjectPrNumber).toBe(99);
    expect(capturedInsertValues.subjectHeadSha).toBe('sha-abc123');
    expect(capturedInsertValues.subjectBranch).toBe('buildd/task-id-some-feature');
    expect(capturedInsertValues.subjectDedupeScope).toBe('active');
  });

  it('populates dependsOn when a sibling task has an overlapping pathManifest', async () => {
    mockTaskFindFirst.mockResolvedValue({
      ...MOCK_TASK,
      // Exact directory prefix — pathsOverlap does literal prefix matching, not glob expansion
      pathManifest: ['apps/web/src/lib'],
      missionId: 'mission-1',
    });
    // Sibling declares a file inside that directory — prefix overlap fires
    mockTaskFindMany.mockResolvedValue([
      { id: 'sibling-task-id', pathManifest: ['apps/web/src/lib/foo.ts'] },
    ]);

    const result = await dispatchConflictRetry(BASE_PARAMS);

    expect(result.dispatched).toBe(true);
    expect(capturedInsertValues.dependsOn).toEqual(['sibling-task-id']);
  });

  it('does not populate dependsOn when no sibling tasks overlap', async () => {
    mockTaskFindFirst.mockResolvedValue({
      ...MOCK_TASK,
      pathManifest: ['apps/web/src/lib'],
      missionId: 'mission-1',
    });
    // Sibling is in a completely separate area — no overlap
    mockTaskFindMany.mockResolvedValue([
      { id: 'other-task-id', pathManifest: ['apps/runner/src/workers.ts'] },
    ]);

    const result = await dispatchConflictRetry(BASE_PARAMS);

    expect(result.dispatched).toBe(true);
    expect(capturedInsertValues.dependsOn).toBeUndefined();
  });

  it('sets pathManifest on the inserted task', async () => {
    mockTaskFindFirst.mockResolvedValue({
      ...MOCK_TASK,
      pathManifest: ['packages/core/db'],
      missionId: null,
    });
    mockTaskFindMany.mockResolvedValue([]);

    await dispatchConflictRetry(BASE_PARAMS);

    expect(capturedInsertValues.pathManifest).toEqual(['packages/core/db']);
  });

  it("defaults pathManifest to ['**'] for mission tasks without an explicit pathManifest", async () => {
    // MOCK_TASK has pathManifest: null and missionId: 'mission-1'
    await dispatchConflictRetry(BASE_PARAMS);

    expect(capturedInsertValues.pathManifest).toEqual(['**']);
  });

  it('returns dispatched=false when workspace is not found', async () => {
    mockWorkspaceFindFirst.mockResolvedValue(null);
    const result = await dispatchConflictRetry(BASE_PARAMS);
    expect(result.dispatched).toBe(false);
  });

  it('returns disabled=true when autoResolveMergeConflicts is false', async () => {
    mockWorkspaceFindFirst.mockResolvedValue({
      id: 'ws-1',
      gitConfig: { autoResolveMergeConflicts: false },
    });
    const result = await dispatchConflictRetry(BASE_PARAMS);
    expect(result.dispatched).toBe(false);
    expect(result.disabled).toBe(true);
  });

  it('returns exhausted=true when iteration cap is reached', async () => {
    mockTaskFindFirst.mockResolvedValue({
      ...MOCK_TASK,
      context: { conflictIteration: 3 },
    });
    const result = await dispatchConflictRetry(BASE_PARAMS);
    expect(result.dispatched).toBe(false);
    expect(result.exhausted).toBe(true);
  });
});
