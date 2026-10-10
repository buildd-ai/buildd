import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── DB mock setup (hoisted before imports) ────────────────────────────────────

const mockTaskFindFirst = mock(() => Promise.resolve(null) as any);
const mockWorkerFindFirst = mock(() => Promise.resolve(null) as any);
const mockWorkspaceFindFirst = mock(() => Promise.resolve(null) as any);
const mockTaskFindMany = mock(() => Promise.resolve([]) as any);
const mockLiveConflictRetryProbe = mock((_args?: any) => Promise.resolve(null) as any);
// Has an attempt already repaired this exact conflict basis (head + base)?
const mockConflictBasisProbe = mock((_args?: any) => Promise.resolve(null) as any);
let capturedInsertValues: any = null;
const mockInsertReturning = mock(() => Promise.resolve([{ id: 'new-task-id' }]) as any);
const mockInsertOnConflict = mock(() => ({ returning: mockInsertReturning }));
const mockInsertValues = mock((vals: any) => {
  capturedInsertValues = vals;
  return { onConflictDoNothing: mockInsertOnConflict };
});
const mockInsert = mock(() => ({ values: mockInsertValues }));
// releaseSpentConflictRetryKey: db.update(tasks).set(..).where(..).returning(..)
let capturedUpdateSet: any = null;
let capturedUpdateWhere: any = null;
const mockUpdateReturning = mock(() => Promise.resolve([]) as any);
const mockUpdate = mock(() => ({
  set: (vals: any) => {
    capturedUpdateSet = vals;
    return {
      where: (w: any) => {
        capturedUpdateWhere = w;
        return { returning: mockUpdateReturning };
      },
    };
  },
}));

const mockAnnounceTaskCreated = mock((..._a: unknown[]) => Promise.resolve());
const mockWakeTask = mock((..._a: unknown[]) => Promise.resolve());

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        // The per-PR in-flight probe is told apart by its column shape, so the
        // many tests that stub the original-task lookup do not answer it.
        findFirst: (...args: any[]) =>
          args[0]?.columns?.conflictRetryPrNumber
            ? mockLiveConflictRetryProbe(...args)
            : args[0]?.columns?.subjectHeadSha
              ? mockConflictBasisProbe(...args)
              : mockTaskFindFirst(...args),
        findMany: (...args: any[]) => mockTaskFindMany(...args),
      },
      workers: { findFirst: (...args: any[]) => mockWorkerFindFirst(...args) },
      workspaces: { findFirst: (...args: any[]) => mockWorkspaceFindFirst(...args) },
    },
    insert: (...args: any[]) => mockInsert(...args),
    update: (...args: any[]) => mockUpdate(...args),
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
  or: (...args: any[]) => ({ or: args }),
  sql: (strings: any, ...values: any[]) => ({ sql: strings, values }),
  isNotNull: (field: any) => ({ isNotNull: field }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ sql: strings.join('?'), values }),
}));

// Keep real path-overlap for meaningful overlap tests
// Full export surface: mock.module is process-global.
mock.module('@/lib/dispatch-authority', () => ({
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  announceTaskCreated: mockAnnounceTaskCreated,
  kickDispatch: mock(() => {}),
  enqueueTaskDispatch: mock(async () => {}),
  drainDispatchOutbox: mock(async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 })),
  deliverTaskDispatch: mock(async () => 'pusher'),
  routeForCause: mock(() => ({ event: 'task.created', legacyDefault: true, legacyUnfilteredRunnerPreference: false })),
  webhookWants: mock(() => false),
  primaryCause: mock((_c: unknown, fallback: unknown) => fallback),
  reseedDispatchTimer: mock(async () => {}),
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
}));

// The behind-only refresh (GitHub update-branch + failure classification +
// opt-in semantic check) lives in base-refresh.ts and has its own suite; here
// only its outcome matters.
const mockUpdateBehindPrBranch = mock(async (_p: any) => ({ kind: 'updated' }) as any);
mock.module('@/lib/base-refresh', () => ({ refreshBehindPr: mockUpdateBehindPrBranch }));

const mockSchedulePrScopeReconcile = mock((_input: any) => {});
mock.module('@/lib/pr-scope-reconcile-trigger', () => ({ schedulePrScopeReconcile: mockSchedulePrScopeReconcile }));

const { GATE_SLUGS: REAL_GATE_SLUGS } = await import('@buildd/core/gate-slugs');
const mockFireGateEvent = mock((_input: any) => 'gate-event-1');
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: REAL_GATE_SLUGS,
  fireGateEvent: mockFireGateEvent,
}));

// The workflow kernel's door (spec §6.7): off by default here (no kernel delivery), so the
// legacy cases below run exactly as before; the kernel block turns it on.
const mockKernelDeliveryForPr = mock(async (..._a: unknown[]) => null as string | null);
const realAuthority = await import('@/lib/workflow/authority');
mock.module('@/lib/workflow/authority', () => ({ ...realAuthority, kernelDeliveryForPr: mockKernelDeliveryForPr }));
const mockObserveConflict = mock(async (_p: any) => ({ handled: false }) as any);
const realSeam = await import('@/lib/workflow/seam');
mock.module('@/lib/workflow/seam', () => ({ ...realSeam, observeConflict: mockObserveConflict }));

import {
  classifyMergeFailure,
  kernelConflictOutcome,
  isAutoResolveMergeConflictsEnabled,
  buildConflictRetryTask,
  dispatchConflictRetry,
  classifyConflictFix,
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

  it('classifies the base-freshness refusal as conflict — same rebase-and-retest remedy as a real conflict', () => {
    // Exact reason shape evaluateAutoMergeSafety's freshness check returns
    // (apps/web/src/lib/auto-merge.ts) when headSha is behind the base
    // branch's current tip. Routing it through 'conflict' is what makes a
    // stale-but-refused PR converge on its own via dispatchConflictRetry
    // instead of sitting parked for a human.
    expect(
      classifyMergeFailure(
        'PR is 3 commits behind dev — the green CI result was measured against a base that no longer exists, needs rebase onto base branch',
      ),
    ).toBe('conflict');
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
    expect(result!.title).toBe('[builder · after conflict #1] feat: add dark mode');
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
    expect(result!.title).toBe('[builder · after conflict #2] feat: add dark mode');
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

  it('strips existing [builder · after conflict #N] prefix from title', () => {
    const input = makeInput({
      originalTask: {
        id: 'task-abc',
        title: '[builder · after conflict #1] feat: add dark mode',
        description: null,
        workspaceId: 'ws-1',
        context: { conflictIteration: 1 },
        missionId: null,
      },
    });
    const result = buildConflictRetryTask(input);
    expect(result!.title).toBe('[builder · after conflict #2] feat: add dark mode');
  });

  it('strips existing [builder · after CI #N] prefix from title', () => {
    const input = makeInput({
      originalTask: {
        id: 'task-abc',
        title: '[builder · after CI #2] feat: add dark mode',
        description: null,
        workspaceId: 'ws-1',
        context: null,
        missionId: null,
      },
    });
    const result = buildConflictRetryTask(input);
    expect(result!.title).toBe('[builder · after conflict #1] feat: add dark mode');
  });

  it('stamps the chain root and PR numbers into the context', () => {
    const result = buildConflictRetryTask(makeInput());
    expect(result!.context.rootTaskId).toBe('task-abc');
    expect(result!.context.lineagePrNumbers).toEqual([42]);
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

  describe('migrationCollision flavor', () => {
    const collision = { file: '0093_safe.sql', otherFile: '0093_other.sql', otherPrNumber: 100 };

    it('titles and describes the task as a migration collision, not a merge conflict', () => {
      const result = buildConflictRetryTask(makeInput({ migrationCollision: collision }));
      expect(result).not.toBeNull();
      expect(result!.title).toBe('[builder · migration collision #1] feat: add dark mode');
      expect(result!.description).toContain('migration-number collision with open PR #100');
      expect(result!.description).toContain('0093_safe.sql');
      expect(result!.description).toContain('0093_other.sql');
      expect(result!.description).not.toContain('merge conflicts with the base branch');
    });

    it('describes a slot taken on the base as a renumber past the base, with no other PR', () => {
      const result = buildConflictRetryTask(makeInput({
        migrationCollision: { file: '0093_safe.sql', otherFile: '0093_landed.sql', otherPrNumber: null, against: 'base' },
      }));
      expect(result!.title).toBe('[builder · migration collision #1] feat: add dark mode');
      expect(result!.description).toContain('its base already has `0093_landed.sql`');
      expect(result!.description).toContain("past the base's newest migration");
      expect(result!.description).not.toContain('PR #null');
      expect(result!.description).not.toContain('/pull/null');
      expect((result!.context.failureContext as any).summary).toContain('already on its base');
    });

    it('names the bound PR head up front when it differs from the worker branch', () => {
      const result = buildConflictRetryTask(makeInput({
        migrationCollision: collision,
        prRefs: { headRef: 'mission/m-1', baseRef: 'dev' },
      }));
      expect(result!.description).toContain('Bound PR lineage');
      expect(result!.description).toContain('Push to `mission/m-1`');
      expect(result!.description).toContain('409');
    });

    it('generic conflict brief routes the push to the bound PR head, not create_pr', () => {
      const result = buildConflictRetryTask(makeInput({
        prRefs: { headRef: 'mission/m-1', baseRef: 'dev' },
      }));
      expect(result!.description).toContain('Bound PR lineage');
      expect(result!.description).toContain('Push the resolved merge to `mission/m-1`');
      expect(result!.description).toContain('409');
    });

    it('generic conflict brief is unchanged when the PR head is the worker branch', () => {
      const result = buildConflictRetryTask(makeInput({
        prRefs: { headRef: 'feat/dark-mode', baseRef: 'dev' },
      }));
      expect(result!.description).not.toContain('Bound PR lineage');
    });

    it('omits the lineage note when the PR head is the worker branch', () => {
      const result = buildConflictRetryTask(makeInput({ migrationCollision: collision }));
      expect(result!.description).not.toContain('Bound PR lineage');
      expect(result!.description).toContain('Push to the existing branch');
    });

    it('sets errorType to migration_collision in failureContext', () => {
      const result = buildConflictRetryTask(makeInput({ migrationCollision: collision }));
      expect((result!.context.failureContext as any).errorType).toBe('migration_collision');
    });

    it('still honors the iteration cap like a normal conflict retry', () => {
      const input = makeInput({
        migrationCollision: collision,
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
    mockAnnounceTaskCreated.mockReset();
    mockWakeTask.mockReset();

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
    mockAnnounceTaskCreated.mockResolvedValue(undefined);
    mockLiveConflictRetryProbe.mockReset();
    mockLiveConflictRetryProbe.mockResolvedValue(null);
    mockUpdate.mockClear();
    mockUpdateReturning.mockReset();
    mockUpdateReturning.mockResolvedValue([]);
    capturedUpdateSet = null;
    capturedUpdateWhere = null;
  });

  // A retry that ended without pushing leaves the PR head unchanged, so it
  // keeps the (PR, head) dedupe key. Every later dispatch for the still-dirty
  // head hit the unique index and filed nothing, yet callers read that as
  // "already handled". The PR sat dirty with nobody working on it.
  describe('a spent retry on the same head', () => {
    it('releases the spent key and files the next attempt', async () => {
      mockInsertReturning
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'next-attempt' }]);
      mockUpdateReturning.mockResolvedValueOnce([{ id: 'spent-attempt' }]);

      const result = await dispatchConflictRetry(BASE_PARAMS);

      expect(result).toEqual({ dispatched: true, taskId: 'next-attempt' });
      expect(mockInsertReturning).toHaveBeenCalledTimes(2);
      expect(capturedUpdateSet).toEqual({ conflictRetryHeadSha: null });
      // Only a terminal row on this exact head gives up its key.
      const where = JSON.stringify(capturedUpdateWhere);
      expect(where).toContain('ws-1');
      expect(where).toContain('99');
      expect(where).toContain('sha-abc123');
      expect(where).toContain('completed');
      expect(where).not.toContain('in_progress');
      expect(mockWakeTask).toHaveBeenCalledTimes(1);
    });

    it('files nothing when the key is held by a live retry (a concurrent caller won)', async () => {
      mockInsertReturning.mockResolvedValue([]);
      mockUpdateReturning.mockResolvedValueOnce([]);

      const result = await dispatchConflictRetry(BASE_PARAMS);

      expect(result).toEqual({ dispatched: false });
      expect(mockInsertReturning).toHaveBeenCalledTimes(1);
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    it('does not touch the key when the first insert succeeds', async () => {
      await dispatchConflictRetry(BASE_PARAMS);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  // N10: a conflict retry that pushes a merge commit moves the PR head, and a
  // new head is a new (PR, SHA) key — so the unique index let a second and a
  // third retry in while the first was still working the same branch.
  it('does not dispatch a second conflict retry while one is live on the same PR at another head', async () => {
    mockLiveConflictRetryProbe.mockResolvedValue({ id: 'live-retry', conflictRetryHeadSha: 'sha-older' });

    const result = await dispatchConflictRetry(BASE_PARAMS);

    expect(result.dispatched).toBe(false);
    expect(result.inFlightTaskId).toBe('live-retry');
    expect(result.exhausted).toBeUndefined();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  // S37: the existing remediation is canonical. A stalled one is recovered in
  // place (keyed by the task + a throttle window), never shadowed by a second.
  describe('S37 — a stalled live conflict fix is recovered, not duplicated', () => {
    const OLD = new Date(Date.now() - 45 * 60_000);
    const pendingStalled = { id: 'live-retry', conflictRetryHeadSha: 'sha-older', status: 'pending', createdAt: OLD, claimedAt: null, updatedAt: OLD, context: {} };

    it('re-dispatches a pending fix no runner claimed, and files nothing new', async () => {
      mockLiveConflictRetryProbe.mockResolvedValue(pendingStalled);
      mockUpdateReturning.mockResolvedValueOnce([{ id: 'live-retry' }]);
      const result = await dispatchConflictRetry({ ...BASE_PARAMS, humanInitiated: true });
      expect(result).toMatchObject({ dispatched: false, inFlightTaskId: 'live-retry', remediationStalled: true, remediationRecovery: 'redispatch' });
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockWakeTask).toHaveBeenCalledWith('live-retry', 'conflict.retry');
      expect(capturedUpdateSet.context.conflictRecovery.action).toBe('redispatch');
      expect(capturedUpdateSet.status).toBeUndefined();
    });

    it('repairs a claimed fix whose worker already ended: back to pending, then woken', async () => {
      mockLiveConflictRetryProbe.mockResolvedValue({ ...pendingStalled, status: 'assigned', claimedAt: OLD });
      mockWorkerFindFirst.mockResolvedValue({ status: 'failed', updatedAt: OLD });
      mockUpdateReturning.mockResolvedValueOnce([{ id: 'live-retry' }]);
      const result = await dispatchConflictRetry(BASE_PARAMS);
      expect(result.remediationRecovery).toBe('repair');
      expect(capturedUpdateSet.status).toBe('pending');
      expect(capturedUpdateSet.claimedAt).toBeNull();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('a concurrent caller that loses the compare-and-set applies nothing (duplicate sweep/click/webhook)', async () => {
      mockLiveConflictRetryProbe.mockResolvedValue(pendingStalled);
      mockUpdateReturning.mockResolvedValueOnce([]);
      const result = await dispatchConflictRetry(BASE_PARAMS);
      expect(result).toMatchObject({ dispatched: false, inFlightTaskId: 'live-retry', remediationStalled: true, remediationRecovery: 'none' });
      expect(mockWakeTask).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('a fix re-dispatched a minute ago is waiting again, not stalled: no second recovery', async () => {
      mockLiveConflictRetryProbe.mockResolvedValue({ ...pendingStalled, context: { conflictRecovery: { at: new Date(Date.now() - 60_000).toISOString() } } });
      const result = await dispatchConflictRetry(BASE_PARAMS);
      expect(result).toEqual({ dispatched: false, inFlightTaskId: 'live-retry' });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    it('a fresh pending fix is left alone', async () => {
      const now = new Date();
      mockLiveConflictRetryProbe.mockResolvedValue({ ...pendingStalled, createdAt: now, updatedAt: now });
      const result = await dispatchConflictRetry(BASE_PARAMS);
      expect(result).toEqual({ dispatched: false, inFlightTaskId: 'live-retry' });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('classifyConflictFix: a silent live worker is stalled but never raced', () => {
      const now = Date.now();
      expect(classifyConflictFix({ status: 'in_progress', createdAt: OLD, workerStatus: 'running', workerUpdatedAt: new Date(now - 30 * 60_000) }, now))
        .toMatchObject({ stalled: true, action: 'none' });
      expect(classifyConflictFix({ status: 'in_progress', createdAt: OLD, workerStatus: 'running', workerUpdatedAt: new Date(now - 60_000) }, now))
        .toEqual({ stalled: false, reason: null, action: 'none' });
    });
  });

  it('scopes the in-flight probe to this workspace, this PR and live statuses', async () => {
    await dispatchConflictRetry(BASE_PARAMS);

    expect(mockLiveConflictRetryProbe).toHaveBeenCalledTimes(1);
    const flat = JSON.stringify(mockLiveConflictRetryProbe.mock.calls[0][0].where);
    expect(flat).toContain('ws-1');
    expect(flat).toContain('99');
    expect(flat).toContain('in_progress');
    expect(flat).not.toContain('completed');
  });

  it('does not touch the branch of a PR a conflict retry is already working', async () => {
    mockUpdateBehindPrBranch.mockClear();
    mockWorkspaceFindFirst.mockResolvedValue({ ...MOCK_WORKSPACE, githubInstallation: { installationId: 5 } });
    mockLiveConflictRetryProbe.mockResolvedValue({ id: 'live-retry', conflictRetryHeadSha: 'sha-older' });

    const result = await dispatchConflictRetry({ ...BASE_PARAMS, behindOnly: true });

    expect(result.dispatched).toBe(false);
    expect(mockUpdateBehindPrBranch).not.toHaveBeenCalled();
  });

  it('brings a merely-behind PR up to date via GitHub instead of dispatching an agent', async () => {
    mockUpdateBehindPrBranch.mockClear();
    mockWorkspaceFindFirst.mockResolvedValue({ ...MOCK_WORKSPACE, githubInstallation: { installationId: 5 } });

    const result = await dispatchConflictRetry({ ...BASE_PARAMS, behindOnly: true });

    expect(result).toEqual({ dispatched: true, branchUpdated: true });
    expect(mockUpdateBehindPrBranch.mock.calls[0][0]).toMatchObject({
      installationId: 5,
      repoFullName: 'acme/app',
      prNumber: 99,
      headSha: 'sha-abc123',
      workspaceId: 'ws-1',
      taskId: 'task-id',
      missionId: 'mission-1',
    });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  describe('behind-only refresh failures (conflict-aware-orchestration §4)', () => {
    const behind = { ...BASE_PARAMS, behindOnly: true };
    beforeEach(() => {
      mockUpdateBehindPrBranch.mockReset();
      mockWorkspaceFindFirst.mockResolvedValue({ ...MOCK_WORKSPACE, githubInstallation: { installationId: 5 } });
    });

    it.each([
      [{ kind: 'deferred', failure: 'rate_limit', attempts: 1, reason: '429' }, { refreshDeferred: true, refreshFailure: 'rate_limit', refreshReason: '429' }],
      [{ kind: 'deferred', failure: 'transient', attempts: 2, reason: '502' }, { refreshDeferred: true, refreshFailure: 'transient', refreshReason: '502' }],
      [{ kind: 'exhausted', failure: 'auth', attempts: 3, reason: '403' }, { refreshExhausted: true, refreshFailure: 'auth', refreshReason: '403' }],
      [{ kind: 'head_changed', reason: 'moved' }, { headChanged: true }],
      [{ kind: 'in_flight' }, { refreshInFlight: true }],
      [{ kind: 'semantic_deferred', rechecks: 1, reason: 'no index' }, { semanticDeferred: true }],
      [{ kind: 'semantic_unverified', rechecks: 3, reason: 'no index' }, { semanticUnverified: true }],
      [{ kind: 'up_to_date', reason: '422 no new commits' }, { alreadyUpToDate: true }],
      [{ kind: 'exhausted', failure: 'refused', attempts: 3, reason: '422 Validation Failed' }, { refreshExhausted: true, refreshFailure: 'refused' }],
    ])('%o spawns no agent', async (outcome, expected) => {
      mockUpdateBehindPrBranch.mockResolvedValue(outcome);
      const result = await dispatchConflictRetry(behind);
      expect(result).toMatchObject({ dispatched: false, ...expected });
      // Never mistaken for the conflict-iteration cap, which escalates as a conflict.
      expect(result.exhausted).toBeUndefined();
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    it('a verified textual conflict falls through to the existing conflict agent', async () => {
      mockUpdateBehindPrBranch.mockResolvedValue({ kind: 'conflict', reason: '422 merge conflict' });
      const result = await dispatchConflictRetry(behind);
      expect(result.dispatched).toBe(true);
      expect(capturedInsertValues.context.failureContext.errorType).toBe('merge_conflict');
      expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
      expect(mockWakeTask.mock.calls).toEqual([['new-task-id', 'conflict.retry']]);
    });

    it('a verified same-symbol edit dispatches a semantic conflict review carrying the evidence', async () => {
      mockUpdateBehindPrBranch.mockResolvedValue({
        kind: 'semantic_conflict',
        assessment: {
          verdict: 'same_symbol', reason: 'both edit f', baseRef: 'mission/m-1', baseSha: 'b'.repeat(40),
          evidence: [{ path: 'src/a.ts', symbols: ['src/a.ts::computeTotal'] }],
        },
      });
      const result = await dispatchConflictRetry(behind);
      expect(result.dispatched).toBe(true);
      expect(capturedInsertValues.context.failureContext.errorType).toBe('semantic_conflict');
      expect(capturedInsertValues.context.semanticConflict.evidence).toEqual([{ path: 'src/a.ts', symbols: ['src/a.ts::computeTotal'] }]);
      expect(capturedInsertValues.title).toMatch(/semantic/i);
      expect(capturedInsertValues.description).toContain('src/a.ts::computeTotal');
      expect(capturedInsertValues.description).toContain('mission/m-1');
      expect(capturedInsertValues.description).not.toMatch(/rebase|force/i);
    });
  });

  // A "dirty" PR is a hint, not a verdict: GitHub computes mergeability lazily
  // and the flag is often stale right after the base moves. Before an agent is
  // filed, GitHub's own server-side merge against the CURRENT base tip decides.
  describe('conflict claim is re-verified against the current base tip', () => {
    beforeEach(() => {
      mockUpdateBehindPrBranch.mockReset();
      mockFireGateEvent.mockClear();
      mockWorkspaceFindFirst.mockResolvedValue({ ...MOCK_WORKSPACE, githubInstallation: { installationId: 5 } });
    });

    it('stale dirty flag + clean merge: no task, the branch is updated mechanically', async () => {
      mockUpdateBehindPrBranch.mockResolvedValue({ kind: 'updated' });

      const result = await dispatchConflictRetry(BASE_PARAMS);

      expect(result).toEqual({ dispatched: true, branchUpdated: true, conflictFalsePositive: true });
      expect(mockUpdateBehindPrBranch).toHaveBeenCalledTimes(1);
      expect(mockUpdateBehindPrBranch.mock.calls[0][0]).toMatchObject({
        installationId: 5, repoFullName: 'acme/app', prNumber: 99, headSha: 'sha-abc123', taskId: 'task-id',
      });
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
      const gate = mockFireGateEvent.mock.calls.map((c) => c[0]).find((e) => e.reason === 'conflict_false_positive');
      expect(gate).toMatchObject({
        gate: 'base_refresh',
        surface: 'conflict-retry',
        workspaceId: 'ws-1',
        taskId: 'task-id',
        detail: { prNumber: 99, headSha: 'sha-abc123', recheck: 'updated' },
      });
    });

    it('stale dirty flag + head already contains the base: no task, recorded as a false positive', async () => {
      mockUpdateBehindPrBranch.mockResolvedValue({ kind: 'up_to_date', reason: '422 no new commits' });

      const result = await dispatchConflictRetry(BASE_PARAMS);

      expect(result).toEqual({ dispatched: false, alreadyUpToDate: true, conflictFalsePositive: true });
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockFireGateEvent.mock.calls.some((c) => c[0].reason === 'conflict_false_positive')).toBe(true);
    });

    it('no GitHub installation: the recheck cannot run, so the agent is dispatched as today', async () => {
      mockWorkspaceFindFirst.mockResolvedValue({ ...MOCK_WORKSPACE, githubInstallation: null });

      const result = await dispatchConflictRetry(BASE_PARAMS);

      expect(result).toEqual({ dispatched: true, taskId: 'new-task-id' });
      expect(mockUpdateBehindPrBranch).not.toHaveBeenCalled();
    });

    it('a real textual conflict dispatches the conflict agent as today', async () => {
      mockUpdateBehindPrBranch.mockResolvedValue({ kind: 'conflict', reason: '422 merge conflict' });

      const result = await dispatchConflictRetry(BASE_PARAMS);

      expect(result).toEqual({ dispatched: true, taskId: 'new-task-id' });
      expect(capturedInsertValues.context.failureContext.errorType).toBe('merge_conflict');
      expect(mockWakeTask.mock.calls).toEqual([['new-task-id', 'conflict.retry']]);
      expect(mockFireGateEvent.mock.calls.some((c) => c[0].reason === 'conflict_false_positive')).toBe(false);
    });

    it.each([
      ['a thrown recheck', () => Promise.reject(new Error('GitHub API error: 502 Bad Gateway'))],
      ['an operational failure', () => Promise.resolve({ kind: 'deferred', failure: 'transient', attempts: 1, reason: '502' })],
      ['exhausted refresh attempts', () => Promise.resolve({ kind: 'exhausted', failure: 'auth', attempts: 3, reason: '403' })],
      ['a moved head', () => Promise.resolve({ kind: 'head_changed', reason: 'moved' })],
      ['a refresh already in flight', () => Promise.resolve({ kind: 'in_flight' })],
      ['unknown semantic coverage', () => Promise.resolve({ kind: 'semantic_unverified', rechecks: 3, reason: 'no index' })],
      ['no answer at all', () => Promise.resolve(undefined)],
    ])('%s fails toward today\'s behaviour: the agent is dispatched, never dropped', async (_label, impl) => {
      mockUpdateBehindPrBranch.mockImplementation(impl as any);

      const result = await dispatchConflictRetry(BASE_PARAMS);

      expect(result).toEqual({ dispatched: true, taskId: 'new-task-id' });
      expect(capturedInsertValues.context.failureContext.errorType).toBe('merge_conflict');
      expect(mockWakeTask).toHaveBeenCalledTimes(1);
    });

    it('a verified same-symbol edit dispatches a semantic conflict review', async () => {
      mockUpdateBehindPrBranch.mockResolvedValue({
        kind: 'semantic_conflict',
        assessment: { verdict: 'same_symbol', reason: 'both edit f', baseRef: 'dev', evidence: [{ path: 'src/a.ts', symbols: ['src/a.ts::f'] }] },
      });

      const result = await dispatchConflictRetry(BASE_PARAMS);

      expect(result.dispatched).toBe(true);
      expect(capturedInsertValues.context.failureContext.errorType).toBe('semantic_conflict');
    });

    it('a migration-number collision is not re-checked: git cannot see it, so the renumber task is filed', async () => {
      const result = await dispatchConflictRetry({
        ...BASE_PARAMS,
        migrationCollision: { file: '0100_a.sql', otherFile: '0100_b.sql', otherPrNumber: 7 } as any,
      });

      expect(mockUpdateBehindPrBranch).not.toHaveBeenCalled();
      expect(result.dispatched).toBe(true);
      expect(capturedInsertValues.context.failureContext.errorType).toBe('migration_collision');
    });

    it('without a GitHub installation there is nothing to re-check with: dispatched as today', async () => {
      mockWorkspaceFindFirst.mockResolvedValue({ ...MOCK_WORKSPACE, githubInstallation: null });

      const result = await dispatchConflictRetry(BASE_PARAMS);

      expect(mockUpdateBehindPrBranch).not.toHaveBeenCalled();
      expect(result).toEqual({ dispatched: true, taskId: 'new-task-id' });
    });
  });

  // Renovate/Dependabot stop rebasing a branch someone else committed to —
  // GitHub's update-branch run on our behalf counts. The approve → auto-merge
  // → "behind base" path is what pushed to a Renovate branch in production.
  it.each([[true], [false]])('never pushes to a dependency-bot PR branch (behindOnly=%s)', async (behindOnly) => {
    mockUpdateBehindPrBranch.mockClear();
    mockFireGateEvent.mockClear();
    mockWorkspaceFindFirst.mockResolvedValue({ ...MOCK_WORKSPACE, githubInstallation: { installationId: 5 } });
    mockTaskFindFirst.mockResolvedValue({
      ...MOCK_TASK,
      context: { adoptedPr: { prNumber: 99, author: 'renovate[bot]', authorType: 'Bot' } },
    });

    const result = await dispatchConflictRetry({ ...BASE_PARAMS, behindOnly });

    expect(result).toEqual({ dispatched: false, dependencyBot: true });
    expect(mockUpdateBehindPrBranch).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockWakeTask).not.toHaveBeenCalled();
    expect(mockFireGateEvent.mock.calls[0][0]).toMatchObject({
      gate: 'dependency_bot_pr',
      outcome: 'rejected',
      detail: { prNumber: 99, stage: 'conflict_retry' },
    });
  });

  describe('humanInitiated (a person tapped the page action)', () => {
    it('files a fresh retry even though automatic conflict resolution is off for the workspace', async () => {
      mockWorkspaceFindFirst.mockResolvedValue({ ...MOCK_WORKSPACE, gitConfig: { autoResolveMergeConflicts: false } });

      expect(await dispatchConflictRetry(BASE_PARAMS)).toEqual({ dispatched: false, disabled: true });

      const result = await dispatchConflictRetry({ ...BASE_PARAMS, humanInitiated: true });
      expect(result.dispatched).toBe(true);
      expect(result.disabled).toBeUndefined();
    });

    it('gets a fresh budget on top of the attempts already spent, where the automatic loop stays exhausted', async () => {
      mockTaskFindFirst.mockResolvedValue({ ...MOCK_TASK, context: { conflictIteration: 3, maxConflictIterations: 3 } });

      const auto = await dispatchConflictRetry(BASE_PARAMS);
      expect(auto).toMatchObject({ dispatched: false, exhausted: true });

      const human = await dispatchConflictRetry({ ...BASE_PARAMS, humanInitiated: true });
      expect(human.dispatched).toBe(true);
      expect(capturedInsertValues.context.conflictIteration).toBe(4);
      expect(capturedInsertValues.context.maxConflictIterations).toBe(6);
    });

    it('still will not file a second retry while one is live', async () => {
      mockLiveConflictRetryProbe.mockResolvedValue({ id: 'live-retry', conflictRetryHeadSha: 'sha-older' });
      const result = await dispatchConflictRetry({ ...BASE_PARAMS, humanInitiated: true });
      expect(result).toMatchObject({ dispatched: false, inFlightTaskId: 'live-retry' });
    });
  });

  it('never uses the branch-update shortcut for a real conflict', async () => {
    mockUpdateBehindPrBranch.mockClear();
    const result = await dispatchConflictRetry(BASE_PARAMS);
    expect(mockUpdateBehindPrBranch).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(true);
    expect(result.branchUpdated).toBeUndefined();
  });

  it('reconciles the inherited scope against the PR diff at the retried head', async () => {
    mockSchedulePrScopeReconcile.mockClear();
    const result = await dispatchConflictRetry(BASE_PARAMS);
    expect(result.dispatched).toBe(true);
    // No GitHub installation on the default workspace: nothing to read with.
    expect(mockSchedulePrScopeReconcile).not.toHaveBeenCalled();

    mockWorkspaceFindFirst.mockResolvedValue({ ...MOCK_WORKSPACE, githubInstallation: { installationId: 5 } });
    // The pre-dispatch recheck confirms a real conflict.
    mockUpdateBehindPrBranch.mockResolvedValue({ kind: 'conflict', reason: '422 merge conflict' });
    const installed = await dispatchConflictRetry(BASE_PARAMS);
    expect(installed.dispatched).toBe(true);
    expect(mockSchedulePrScopeReconcile).toHaveBeenCalledWith({
      workspaceId: BASE_PARAMS.workspaceId,
      installationId: 5,
      repoFullName: 'acme/app',
      prNumber: 99,
      expectedHeadSha: 'sha-abc123',
    });
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

  it('dispatches a migration-collision-flavored task through the same dedup/cap machinery', async () => {
    const collision = { file: '0093_safe.sql', otherFile: '0093_other.sql', otherPrNumber: 100 };
    const result = await dispatchConflictRetry({ ...BASE_PARAMS, migrationCollision: collision });

    expect(result.dispatched).toBe(true);
    expect(capturedInsertValues).not.toBeNull();
    expect(capturedInsertValues.title).toBe('[builder · migration collision #1] feat: some feature');
    expect(capturedInsertValues.description).toContain('migration-number collision with open PR #100');
    expect(capturedInsertValues.conflictRetryPrNumber).toBe(99);
    expect(capturedInsertValues.conflictRetryHeadSha).toBe('sha-abc123');
  });

  it('does not make a collision repair depend on the task or PR it repairs', async () => {
    const pathManifest = ['packages/core/drizzle'];
    mockTaskFindFirst.mockResolvedValue({ ...MOCK_TASK, pathManifest });
    mockTaskFindMany.mockResolvedValue([
      { status: 'in_progress', id: 'task-id', pathManifest },
      { status: 'in_progress', id: 'same-pr-attempt', pathManifest, subjectPrNumber: 99 },
      { status: 'in_progress', id: 'same-pr-conflict', pathManifest, conflictRetryPrNumber: 99 },
      { status: 'in_progress', id: 'unrelated-sibling', pathManifest, subjectPrNumber: 80 },
    ]);
    const result = await dispatchConflictRetry({
      ...BASE_PARAMS,
      migrationCollision: { file: '0093_safe.sql', otherFile: '0093_other.sql', otherPrNumber: 80 },
    });
    expect(result.dispatched).toBe(true);
    expect(capturedInsertValues.dependsOn).toEqual(['unrelated-sibling']);
  });

  it('a prefix-only overlap with a sibling is soft evidence, never a dependsOn edge', async () => {
    mockTaskFindFirst.mockResolvedValue({
      ...MOCK_TASK,
      pathManifest: ['apps/web/src/lib'],
      missionId: 'mission-1',
    });
    // Sibling declares a file inside that directory — prefix overlap only
    mockTaskFindMany.mockResolvedValue([
      { status: 'in_progress', id: 'sibling-task-id', pathManifest: ['apps/web/src/lib/foo.ts'] },
    ]);

    const result = await dispatchConflictRetry(BASE_PARAMS);

    expect(result.dispatched).toBe(true);
    expect(capturedInsertValues.dependsOn).toBeUndefined();
    expect(capturedInsertValues.pathDeclaration).toMatchObject({
      overlapPolicy: 'v2',
      softOverlaps: [{ taskId: 'sibling-task-id', kind: 'prefix' }],
    });
  });

  it('a sibling declaring the same file is soft same_file evidence, decided at claim', async () => {
    mockTaskFindFirst.mockResolvedValue({ ...MOCK_TASK, pathManifest: ['apps/web/src/lib/foo.ts'], missionId: 'mission-1' });
    mockTaskFindMany.mockResolvedValue([{ status: 'in_progress', id: 'sibling-task-id', pathManifest: ['apps/web/src/lib/foo.ts'] }]);

    const result = await dispatchConflictRetry(BASE_PARAMS);

    expect(result.dispatched).toBe(true);
    expect(capturedInsertValues.dependsOn).toBeUndefined();
    expect(capturedInsertValues.pathDeclaration).toMatchObject({ overlapPolicy: 'v2', softOverlaps: [{ taskId: 'sibling-task-id', kind: 'same_file' }] });
  });

  it('populates dependsOn when a sibling task declares the same migration file', async () => {
    mockTaskFindFirst.mockResolvedValue({ ...MOCK_TASK, pathManifest: ['packages/core/drizzle/0400_x.sql'], missionId: 'mission-1' });
    mockTaskFindMany.mockResolvedValue([{ status: 'in_progress', id: 'sibling-task-id', pathManifest: ['packages/core/drizzle/0400_x.sql'] }]);

    const result = await dispatchConflictRetry(BASE_PARAMS);

    expect(result.dispatched).toBe(true);
    expect(capturedInsertValues.dependsOn).toEqual(['sibling-task-id']);
    expect(capturedInsertValues.pathDeclaration).toMatchObject({ inferredDependsOn: ['sibling-task-id'], overlapPolicy: 'v2' });
  });

  it('does not populate dependsOn when no sibling tasks overlap', async () => {
    mockTaskFindFirst.mockResolvedValue({
      ...MOCK_TASK,
      pathManifest: ['apps/web/src/lib'],
      missionId: 'mission-1',
    });
    // Sibling is in a completely separate area — no overlap
    mockTaskFindMany.mockResolvedValue([
      { status: 'in_progress', id: 'other-task-id', pathManifest: ['apps/runner/src/workers.ts'] },
    ]);

    const result = await dispatchConflictRetry(BASE_PARAMS);

    expect(result.dispatched).toBe(true);
    expect(capturedInsertValues.dependsOn).toBeUndefined();
  });

  // Regression: only the phase was copied, so a Codex task's conflict fix ran
  // on Claude and a role-routed task lost its role and routing kind.
  it('keeps the original task\'s backend, role, kind and phase on the attempt', async () => {
    mockTaskFindFirst.mockResolvedValue({
      ...MOCK_TASK,
      backend: 'codex',
      roleSlug: 'builder',
      kind: 'engineering',
      complexity: 'normal',
      missionPhaseIndex: 1,
      missionPhaseLabel: 'Build',
    });

    await dispatchConflictRetry(BASE_PARAMS);

    expect(capturedInsertValues).toMatchObject({
      backend: 'codex',
      roleSlug: 'builder',
      kind: 'engineering',
      complexity: 'normal',
      missionPhaseIndex: 1,
      missionPhaseLabel: 'Build',
    });
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

  it("conflict retry for a manifest-less mission task does NOT auto-depend on wildcard siblings", async () => {
    // The wildcard sentinel is advisory-only at claim time (findBlockingPr and the
    // path_claims backstop both skip '**'), so the authoring path must not mint a
    // hard dependsOn edge from it. Otherwise every conflict retry inherits an edge
    // to every task alive in the workspace at retry time.
    //
    // MOCK_TASK already has: pathManifest: null, missionId: 'mission-1'
    mockTaskFindMany.mockResolvedValue([
      { status: 'in_progress', id: 'sibling-mission-task', pathManifest: ['**'] },
      { status: 'in_progress', id: 'sibling-concrete-task', pathManifest: ['apps/web/src/lib/other.ts'] },
    ]);

    const result = await dispatchConflictRetry(BASE_PARAMS);

    expect(result.dispatched).toBe(true);
    // Retry still inherits the ['**'] sentinel via the missionId fallback (PR #1780)
    expect(capturedInsertValues.pathManifest).toEqual(['**']);
    // …but it buys no dependency edges, from wildcard or concrete siblings.
    expect(capturedInsertValues.dependsOn).toBeUndefined();
  });

  it('conflict retry with a concrete manifest ignores wildcard siblings but keeps real overlaps', async () => {
    mockTaskFindFirst.mockResolvedValue({
      ...MOCK_TASK,
      pathManifest: ['packages/core/drizzle/0400_x.sql'],
      missionId: 'mission-1',
    });
    mockTaskFindMany.mockResolvedValue([
      { status: 'in_progress', id: 'wildcard-sibling', pathManifest: ['**'] },
      { status: 'in_progress', id: 'overlapping-sibling', pathManifest: ['packages/core/drizzle/0400_x.sql'] },
    ]);

    const result = await dispatchConflictRetry(BASE_PARAMS);

    expect(result.dispatched).toBe(true);
    expect(capturedInsertValues.dependsOn).toEqual(['overlapping-sibling']);
  });

  it('does not depend on a task that is already downstream of the original task, directly or transitively, but still depends on an unrelated overlapping task', async () => {
    // Migration files: a hard overlap, so the edges are real dependsOn candidates.
    const pathManifest = ['packages/core/drizzle/foo.sql', 'packages/core/drizzle/bar.sql', 'packages/core/drizzle/baz.sql'];
    mockTaskFindFirst.mockResolvedValue({ ...MOCK_TASK, pathManifest });
    mockTaskFindMany.mockResolvedValue([
      { status: 'in_progress', id: 'task-id', pathManifest, dependsOn: [] },
      // S: overlaps and already depends directly on the original task.
      { status: 'in_progress', id: 'downstream-direct', pathManifest: ['packages/core/drizzle/foo.sql'], dependsOn: ['task-id'] },
      // S2: overlaps and depends on the original task transitively, through X.
      { status: 'in_progress', id: 'downstream-transitive', pathManifest: ['packages/core/drizzle/bar.sql'], dependsOn: ['intermediate'] },
      { status: 'in_progress', id: 'intermediate', pathManifest: null, dependsOn: ['task-id'] },
      // U: overlaps but has no relationship to the original task.
      { status: 'in_progress', id: 'unrelated-overlap', pathManifest: ['packages/core/drizzle/baz.sql'], dependsOn: [] },
    ]);

    const result = await dispatchConflictRetry(BASE_PARAMS);

    expect(result.dispatched).toBe(true);
    expect(capturedInsertValues.dependsOn).toEqual(['unrelated-overlap']);
  });

  for (const collision of [false, true]) {
    it(`excludes pending work blocked by the subject PR without a stored dependency (collision=${collision})`, async () => {
      const pathManifest = ['packages/core/db/schema.ts', 'packages/core/drizzle'];
      mockTaskFindFirst.mockResolvedValue({ ...MOCK_TASK, pathManifest, dependsOn: ['caller-edge'] });
      mockTaskFindMany.mockResolvedValue([
        { id: 'pending-holder', status: 'pending', pathManifest: ['packages/core/drizzle/0400_x.sql'], dependsOn: [] },
        { id: 'running-holder', status: 'in_progress', pathManifest: ['packages/core/drizzle/0401_y.sql'], dependsOn: [] },
      ]);
      const result = await dispatchConflictRetry({
        ...BASE_PARAMS,
        ...(collision ? { migrationCollision: { file: '0400_x.sql', otherFile: '0400_y.sql', otherPrNumber: 80 } } : {}),
      });
      expect(result.dispatched).toBe(true);
      expect(capturedInsertValues.dependsOn).toEqual(['running-holder']);
      expect(capturedInsertValues.pathDeclaration.inferredDependsOn).toEqual(['running-holder']);
      expect(capturedInsertValues.pathDeclaration.softOverlaps).toBeUndefined();
    });
  }

  it('does not store even soft evidence against pending work held by the subject PR', async () => {
    mockTaskFindFirst.mockResolvedValue({ ...MOCK_TASK, pathManifest: ['apps/web/src/lib'] });
    mockTaskFindMany.mockResolvedValue([
      { id: 'pending-holder', status: 'pending', pathManifest: ['apps/web/src/lib/foo.ts'] },
    ]);
    await dispatchConflictRetry(BASE_PARAMS);
    expect(capturedInsertValues.dependsOn).toBeUndefined();
    expect(capturedInsertValues.pathDeclaration.softOverlaps).toBeUndefined();
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

  // PR #3502's shape: three conflict attempts ran out on earlier conflicts,
  // then the base moved and a new real conflict appeared. The spent budget
  // must not strand it — but the same conflict must not loop either.
  describe('the budget is per conflict basis (head + base) when the caller names the base', () => {
    beforeEach(() => {
      mockConflictBasisProbe.mockReset();
      mockConflictBasisProbe.mockResolvedValue(null);
      mockTaskFindFirst.mockResolvedValue({ ...MOCK_TASK, context: { conflictIteration: 3, maxConflictIterations: 3 } });
    });

    it('files one attempt for a conflict basis no attempt has seen, past the spent cap', async () => {
      const result = await dispatchConflictRetry({ ...BASE_PARAMS, baseSha: 'base-new' });
      expect(result).toEqual({ dispatched: true, taskId: 'new-task-id' });
      expect(capturedInsertValues.context).toMatchObject({
        conflictBasis: 'sha-abc123:base-new',
        conflictIteration: 4,
        maxConflictIterations: 4,
      });
      const probe = JSON.stringify(mockConflictBasisProbe.mock.calls[0]![0].where);
      expect(probe).toContain('sha-abc123:base-new');
      expect(probe).toContain('99');
    });

    it('treats a basis that was already attempted as exhausted (a person, not a loop)', async () => {
      mockConflictBasisProbe.mockResolvedValue({ id: 'earlier-attempt' });
      const result = await dispatchConflictRetry({ ...BASE_PARAMS, baseSha: 'base-new' });
      expect(result).toEqual({ dispatched: false, exhausted: true });
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('keeps the cap absolute when the base is unknown', async () => {
      const result = await dispatchConflictRetry(BASE_PARAMS);
      expect(result.exhausted).toBe(true);
      expect(mockConflictBasisProbe).not.toHaveBeenCalled();
    });

    it('stamps the basis on an attempt inside the budget too', async () => {
      mockTaskFindFirst.mockResolvedValue({ ...MOCK_TASK, context: {} });
      await dispatchConflictRetry({ ...BASE_PARAMS, baseSha: 'base-1' });
      expect(capturedInsertValues.context.conflictBasis).toBe('sha-abc123:base-1');
      expect(mockConflictBasisProbe).not.toHaveBeenCalled();
    });
  });

  describe('one live fix attempt per PR', () => {
    it('counts a live CI or review fix on the same PR as the one attempt', async () => {
      mockLiveConflictRetryProbe.mockResolvedValue({ id: 'live-ci-fix', status: 'in_progress', conflictRetryPrNumber: null });
      const result = await dispatchConflictRetry(BASE_PARAMS);
      expect(result).toEqual({ dispatched: false, inFlightTaskId: 'live-ci-fix' });
      const flat = JSON.stringify(mockLiveConflictRetryProbe.mock.calls[0]![0].where);
      expect(flat).toContain('or');
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    it('reconciles a pending v2 repair in place before waking it, preserving explicit and active-work edges', async () => {
      mockTaskFindFirst.mockResolvedValue({ ...MOCK_TASK, pathManifest: ['packages/core/drizzle'] });
      mockLiveConflictRetryProbe.mockResolvedValue({
        id: 'pending-repair', taskClass: 'attempt', status: 'pending', conflictRetryPrNumber: 99,
        dependsOn: ['pending-holder', 'running-holder', 'explicit-holder'],
        pathDeclaration: { overlapPolicy: 'v2', inferredDependsOn: ['pending-holder', 'running-holder'] },
      });
      mockTaskFindMany.mockResolvedValue([
        { id: 'pending-holder', status: 'pending', pathManifest: ['packages/core/drizzle/0400_x.sql'] },
        { id: 'running-holder', status: 'in_progress', pathManifest: ['packages/core/drizzle/0401_y.sql'] },
        { id: 'explicit-holder', status: 'pending', pathManifest: ['packages/core/drizzle/0402_z.sql'] },
      ]);
      expect(await dispatchConflictRetry(BASE_PARAMS)).toEqual({ dispatched: false, inFlightTaskId: 'pending-repair' });
      expect(capturedUpdateSet.dependsOn).toEqual(['running-holder', 'explicit-holder']);
      expect(capturedUpdateSet.pathDeclaration.inferredDependsOn).toEqual(['running-holder']);
      expect(mockWakeTask).toHaveBeenCalledWith('pending-repair', 'conflict.retry');
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('wakes a conflict repair that is still waiting to start instead of filing another', async () => {
      mockLiveConflictRetryProbe.mockResolvedValue({ id: 'pending-repair', status: 'pending', conflictRetryPrNumber: 99 });
      const result = await dispatchConflictRetry(BASE_PARAMS);
      expect(result).toEqual({ dispatched: false, inFlightTaskId: 'pending-repair' });
      expect(mockWakeTask.mock.calls).toEqual([['pending-repair', 'conflict.retry']]);
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });
});


// ── The kernel owns the conflict family for its PRs (Slice B part 2, §6.7) ────

describe('dispatchConflictRetry for a kernel-owned PR', () => {
  const KERNEL_WS = { id: 'ws-k', repo: 'acme/widgets', gitConfig: {}, githubInstallation: { installationId: 42 } };
  const params = { workerId: 'w1', taskId: 't1', prNumber: 7, headSha: 'H1', repoFullName: 'acme/widgets', workspaceId: 'ws-k' };
  const applied = (toState: string, stateReason: string | null, attempt: Record<string, unknown> | null) => ({
    handled: true, mergeable: 'dirty', after: { state: toState, stateReason, headSha: 'H1' }, attempt,
    result: { result: 'applied', transitionId: 'tr', deliveryId: 'd1', version: 2, decision: { toState, patch: { stateReason }, attempts: [] } },
  });
  beforeEach(() => {
    mockWorkspaceFindFirst.mockReset();
    mockWorkspaceFindFirst.mockResolvedValue(KERNEL_WS);
    mockTaskFindFirst.mockReset();
    mockTaskFindFirst.mockResolvedValue(null); // no live legacy retry; owner context empty
    mockInsert.mockClear();
    mockUpdate.mockClear();
    mockUpdateBehindPrBranch.mockClear();
    mockObserveConflict.mockReset();
    mockKernelDeliveryForPr.mockReset();
    mockKernelDeliveryForPr.mockResolvedValue('d1');
  });

  it('asks the kernel, and the legacy decision (counter, key release, behind refresh, insert) never runs', async () => {
    mockObserveConflict.mockResolvedValue(applied('REPAIRING', 'conflict', { id: 'g1', family: 'conflict', mode: 'agent', status: 'queued', outcome: null, taskId: 'g1' }));
    const res = await dispatchConflictRetry({ ...params, behindOnly: true });
    expect(res).toMatchObject({ dispatched: true, taskId: 'g1' });
    expect(mockObserveConflict.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws-k', prNumber: 7, installationId: 42, hint: 'behind', isDependencyBot: false });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockUpdateBehindPrBranch).not.toHaveBeenCalled();
  });

  it('a disabled workspace still lets the platform refresh, but gives agents no budget', async () => {
    mockWorkspaceFindFirst.mockResolvedValue({ ...KERNEL_WS, gitConfig: { autoResolveMergeConflicts: false } });
    mockObserveConflict.mockResolvedValue(applied('ESCALATED', 'conflict_exhausted', null));
    expect(await dispatchConflictRetry(params)).toMatchObject({ dispatched: false, exhausted: true });
    expect(mockObserveConflict.mock.calls[0][0].maxAgentAttempts).toBe(0);
  });

  it('a migration collision is handed over as the repair subject', async () => {
    mockObserveConflict.mockResolvedValue(applied('REPAIRING', 'migration', { id: 'm1', family: 'migration', mode: 'mechanical', status: 'ended', outcome: 'delivered', taskId: null }));
    const collision = { file: '0007_a.sql', otherFile: '0007_b.sql', otherPrNumber: 3 };
    expect(await dispatchConflictRetry({ ...params, migrationCollision: collision })).toMatchObject({ dispatched: true, branchUpdated: true });
    expect(mockObserveConflict.mock.calls[0][0].migrationCollision).toEqual(collision);
  });

  it('not kernel-owned: the kernel is not asked', async () => {
    mockKernelDeliveryForPr.mockResolvedValue(null);
    await dispatchConflictRetry(params).catch(() => null);
    expect(mockObserveConflict).not.toHaveBeenCalled();
  });
});

describe('kernelConflictOutcome', () => {
  const seen = (result: Record<string, unknown>, attempt: Record<string, unknown> | null = null, state: string | null = null) =>
    ({ handled: true, mergeable: 'dirty', after: state ? { state, stateReason: null, headSha: 'H1' } : null, attempt, result }) as never;
  const rej = (reason: string) => ({ result: 'rejected', reason, current: { state: 'REPAIRING', version: 3, head: 'H1', round: 1 } });
  it('maps the kernel answer onto the shape the doors understand', () => {
    expect(kernelConflictOutcome(seen(rej('not_conflicting')))).toMatchObject({ dispatched: false, alreadyUpToDate: true });
    expect(kernelConflictOutcome(seen(rej('dependency_bot_pr')))).toMatchObject({ dispatched: false, dependencyBot: true });
    expect(kernelConflictOutcome(seen({ result: 'stale', reason: 'head_not_current', current: null }))).toMatchObject({ dispatched: false, headChanged: true });
    expect(kernelConflictOutcome(seen(rej('fix_in_flight'), { id: 'g1', mode: 'agent', taskId: 'g1' }))).toMatchObject({ dispatched: false, inFlightTaskId: 'g1' });
    expect(kernelConflictOutcome(seen(rej('fix_in_flight'), { id: 'm1', mode: 'mechanical', taskId: null }))).toMatchObject({ dispatched: false, refreshInFlight: true });
    const esc = (reason: string) => ({ result: 'applied', decision: { toState: 'ESCALATED', patch: { stateReason: reason }, attempts: [] } });
    expect(kernelConflictOutcome(seen(esc('landing_needs_human')))).toMatchObject({ dispatched: false, refreshExhausted: true });
    expect(kernelConflictOutcome(seen(esc('conflict_exhausted')))).toMatchObject({ dispatched: false, exhausted: true });
    const rep = { result: 'applied', decision: { toState: 'REPAIRING', patch: { stateReason: 'behind' }, attempts: [] } };
    expect(kernelConflictOutcome(seen(rep, { mode: 'mechanical', status: 'queued', outcome: null }))).toMatchObject({ dispatched: false, refreshQueued: true });
    expect(kernelConflictOutcome(seen(rep, { mode: 'mechanical', status: 'skipped', outcome: 'noop' }))).toMatchObject({ dispatched: false, alreadyUpToDate: true });
  });

  // A queued mechanical refresh already ran (or is running): it is not an
  // operational failure, and nothing downstream may render it as one.
  it('a queued mechanical refresh is refreshQueued, never refreshDeferred', () => {
    const rep = { result: 'applied', decision: { toState: 'REPAIRING', patch: { stateReason: 'behind' }, attempts: [] } };
    const out = kernelConflictOutcome(seen(rep, { mode: 'mechanical', status: 'queued', outcome: null }));
    expect(out.refreshQueued).toBe(true);
    expect(out.refreshDeferred).toBeUndefined();
  });

  it('the treadmill escalation carries its refresh count and the kernel detail', () => {
    const treadmill = {
      result: 'applied',
      decision: {
        toState: 'ESCALATED', patch: { stateReason: 'landing_needs_human' }, attempts: [],
        effects: [{ kind: 'notify', dedupeKey: 'n', payload: { event: 'landing_needs_human', detail: 'base moved 3 times under the approved PR' } }],
        evidence: { repairKind: 'behind', headSha: 'H1', refreshes: 3 },
      },
    };
    expect(kernelConflictOutcome(seen(treadmill))).toMatchObject({
      dispatched: false, refreshExhausted: true, refreshTreadmill: 3, refreshReason: 'base moved 3 times under the approved PR',
    });
  });

  it('a mechanical refresh that ended failed and escalated names the delivery reason', () => {
    const rep = { result: 'applied', decision: { toState: 'REPAIRING', patch: { stateReason: 'behind' }, attempts: [] } };
    const out = kernelConflictOutcome(
      ({ handled: true, mergeable: 'behind', after: { state: 'ESCALATED', stateReason: 'landing_needs_human', headSha: 'H1' }, attempt: { mode: 'mechanical', status: 'ended', outcome: 'failed' }, result: rep }) as never,
    );
    expect(out).toMatchObject({ dispatched: false, refreshExhausted: true });
    expect(out.refreshReason).toContain('landing_needs_human');
    expect(out.refreshTreadmill).toBeUndefined();
  });
});
