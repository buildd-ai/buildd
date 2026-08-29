import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ─── DB mocks ─────────────────────────────────────────────────────────────────

const mockTasksFindMany = mock(() => [] as any[]);
const mockWorkersFindMany = mock(() => [] as any[]);

/** Rows the terminating UPDATE ... RETURNING resolves to. Set per test. */
let updateReturning: Array<{ id: string }> = [];

const setSpy = mock((values: any) => values);
const whereSpy = mock((cond: any) => cond);
const mockDbUpdate = mock(() => ({
  set: (values: any) => {
    setSpy(values);
    return {
      where: (cond: any) => {
        whereSpy(cond);
        return { returning: () => Promise.resolve(updateReturning) };
      },
    };
  },
}));

const insertValuesSpy = mock((rows: any) => rows);
const mockDbInsert = mock(() => ({
  values: (rows: any) => {
    insertValuesSpy(rows);
    return Promise.resolve();
  },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findMany: mockTasksFindMany },
      workers: { findMany: mockWorkersFindMany },
    },
    update: () => mockDbUpdate(),
    insert: () => mockDbInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  or: (...args: any[]) => ({ args, op: 'or' }),
  isNull: (a: any) => ({ a, op: 'isNull' }),
  isNotNull: (a: any) => ({ a, op: 'isNotNull' }),
  inArray: (a: any, b: any) => ({ a, b, op: 'inArray' }),
  ne: (a: any, b: any) => ({ a, b, op: 'ne' }),
  not: (a: any) => ({ a, op: 'not' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: {
    id: 'id',
    workspaceId: 'workspaceId',
    subjectPrNumber: 'subjectPrNumber',
    subjectKind: 'subjectKind',
    subjectAnchor: 'subjectAnchor',
    subjectResolution: 'subjectResolution',
    status: 'status',
    parentTaskId: 'parentTaskId',
    updatedAt: 'updatedAt',
  },
  workers: {
    taskId: 'taskId',
    prNumber: 'prNumber',
    prLifecycleStatus: 'prLifecycleStatus',
  },
  taskSubjectReports: { taskId: 'taskId' },
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { sweepSubjectAnchoredTasks } from './subject-sweep';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The identifying anchor class: system-asserted, confidence exact. */
const EXACT_ANCHOR = {
  version: 1,
  kind: 'pull_request',
  prNumber: 42,
  source: 'system',
  confidence: 'exact',
} as const;

/** The advisory class: a PR number scraped from prose. */
const DERIVED_ANCHOR = {
  version: 1,
  kind: 'pull_request',
  prNumber: 42,
  source: 'text',
  confidence: 'derived',
} as const;

function makeTask(overrides: Partial<{
  id: string;
  status: string;
  parentTaskId: string | null;
  subjectResolution: string | null;
  subjectAnchor: Record<string, unknown> | null;
}> = {}) {
  return {
    id: 'task-1',
    status: 'pending',
    parentTaskId: null,
    subjectResolution: null,
    subjectAnchor: { ...EXACT_ANCHOR },
    ...overrides,
  };
}

function makeWorker(overrides: Partial<{
  taskId: string;
  prNumber: number | null;
  prLifecycleStatus: string | null;
}> = {}) {
  return {
    taskId: 'task-1',
    prNumber: 42,
    prLifecycleStatus: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sweepSubjectAnchoredTasks', () => {
  beforeEach(() => {
    mockTasksFindMany.mockReset();
    mockWorkersFindMany.mockReset();
    mockDbUpdate.mockClear();
    mockDbInsert.mockClear();
    setSpy.mockClear();
    whereSpy.mockClear();
    insertValuesSpy.mockClear();
    updateReturning = [];
  });

  it('returns zeros when no anchored tasks found', async () => {
    mockTasksFindMany.mockResolvedValue([]);
    const result = await sweepSubjectAnchoredTasks('ws-1', 42);
    expect(result).toEqual({ anchored: 0, reconciled: 0, cancelled: 0 });
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
  });

  it('cancels pending tasks when PR has no live worker PRs', async () => {
    // Anchored task is pending with no open PR — must be CANCELLED so it falls
    // out of the claim queue and mission-completion count (not just reconciled),
    // and so its dependents stop waiting on a task that can never complete.
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-1', status: 'pending' })]);
    mockWorkersFindMany.mockResolvedValue([]);
    updateReturning = [{ id: 'task-1' }];

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.anchored).toBeGreaterThan(0);
    expect(result.reconciled).toBe(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subjectResolution: 'reconciled', status: 'cancelled' }),
    );
  });

  it('cancels a budget-deferred pending task when its PR dies', async () => {
    // The "stranded nine" scenario: CI-retry task was deferred (pending with
    // a future startAt) after hitting session limit. Its PR was later merged.
    // The sweep must cancel it — leaving it pending makes it permanently
    // invisible to the claim route (SQL pre-filter) while blocking queue counts.
    const deferredTask = makeTask({ id: 'deferred-1', status: 'pending', subjectResolution: null });
    mockTasksFindMany.mockResolvedValueOnce([deferredTask]);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ taskId: 'deferred-1', prLifecycleStatus: 'merged' }),
    ]);

    updateReturning = [{ id: 'deferred-1' }];

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subjectResolution: 'reconciled', status: 'cancelled' }),
    );
  });

  it('cancels assigned tasks when PR is dead', async () => {
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-2', status: 'assigned' })]);
    mockWorkersFindMany.mockResolvedValue([]);
    updateReturning = [{ id: 'task-2' }];

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subjectResolution: 'reconciled', status: 'cancelled' }),
    );
  });

  it('does NOT reconcile when a retry-chain worker has a live PR', async () => {
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-1', status: 'pending' })]);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ taskId: 'task-1', prLifecycleStatus: 'pr_open' }),
    ]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('does NOT reconcile when worker PR is in ci_running state (live)', async () => {
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-1', status: 'pending' })]);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ taskId: 'task-1', prLifecycleStatus: 'ci_running' }),
    ]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('cancels when only closed/merged workers exist in the chain', async () => {
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-1', status: 'pending' })]);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ taskId: 'task-1', prLifecycleStatus: 'closed' }),
    ]);
    updateReturning = [{ id: 'task-1' }];

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('cancels when worker PR is merged', async () => {
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-1', status: 'pending' })]);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ taskId: 'task-1', prLifecycleStatus: 'merged' }),
    ]);
    updateReturning = [{ id: 'task-1' }];

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('does NOT update completed tasks', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-1', status: 'completed' }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('does NOT update failed tasks', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-1', status: 'failed' }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('is idempotent — already-reconciled tasks are not re-updated', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-1', status: 'pending', subjectResolution: 'reconciled' }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(result.cancelled).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('sweeps retry-chain members connected by parentTaskId', async () => {
    mockTasksFindMany
      .mockResolvedValueOnce([
        makeTask({ id: 'task-1', status: 'pending', parentTaskId: 'task-parent' }),
      ])
      .mockResolvedValueOnce([{ id: 'task-parent', status: 'failed' }])
      .mockResolvedValueOnce([
        makeTask({ id: 'task-1', status: 'pending', parentTaskId: 'task-parent' }),
        makeTask({ id: 'task-2', status: 'pending', parentTaskId: 'task-parent' }),
      ]);
    mockWorkersFindMany.mockResolvedValue([]);
    updateReturning = [{ id: 'task-1' }];

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    // Exactly the directly-anchored task (task-1) is reconciled; siblings are
    // not in the anchored set and are not touched by the sweep.
    expect(result.reconciled).toBe(1);
  });

  it('handles multiple anchored tasks, reconciling only pending/assigned ones', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-1', status: 'pending' }),
      makeTask({ id: 'task-2', status: 'completed' }),
      makeTask({ id: 'task-3', status: 'assigned' }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);
    updateReturning = [{ id: 'task-1' }, { id: 'task-3' }];

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.anchored).toBeGreaterThan(0);
    expect(result.reconciled).toBe(2); // task-1 (pending) + task-3 (assigned)
  });
});

// ─── D4: a dead subject terminates the task (drains the chain) ───────────────

describe('sweepSubjectAnchoredTasks — termination of dead-subject tasks', () => {
  beforeEach(() => {
    mockTasksFindMany.mockReset();
    mockWorkersFindMany.mockReset();
    mockDbUpdate.mockClear();
    mockDbInsert.mockClear();
    setSpy.mockClear();
    whereSpy.mockClear();
    insertValuesSpy.mockClear();
    updateReturning = [];
  });

  it('cancels the task when an exact/identifying anchor has a dead subject', async () => {
    // The moa-ops "[CI Retry #1]" population: source system / confidence exact,
    // anchored to a genuinely closed PR, left pending for days. Leaving it
    // pending also starves every dependent (deps-gate only treats completed or
    // cancelled deps as satisfied), so termination is what drains the chain.
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-ci', status: 'pending' })]);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ taskId: 'task-ci', prLifecycleStatus: 'closed' }),
    ]);
    updateReturning = [{ id: 'task-ci' }];

    const result = await sweepSubjectAnchoredTasks('ws-1', 155);

    expect(result.cancelled).toBe(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled', subjectResolution: 'reconciled' }),
    );
  });

  it('cancelling is what unblocks dependents — cancelled is the deps-gate escape hatch', async () => {
    // Guard on the contract rather than the SQL: DEP_SATISFYING_STATUSES is what
    // the claim dep gate builds its IN(...) list from, so a cancelled dep is
    // satisfied and its dependents become claimable.
    const { DEP_SATISFYING_STATUSES } = await import('./dep-gate-contract');
    expect([...DEP_SATISFYING_STATUSES]).toContain('cancelled');

    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'dep-task', status: 'pending' })]);
    mockWorkersFindMany.mockResolvedValue([]);
    updateReturning = [{ id: 'dep-task' }];

    await sweepSubjectAnchoredTasks('ws-1', 42);

    const written = setSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(written.status).toBe('cancelled');
  });

  it('REGRESSION (aeb80f): a derived text anchor is neither reconciled nor cancelled', async () => {
    // Pre-fix prod shape: the description merely mentioned "PR #1789" as
    // background. A naive version of this fix would have auto-cancelled it —
    // strictly worse than the original bug.
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'aeb80f', status: 'pending', subjectAnchor: { ...DERIVED_ANCHOR, prNumber: 1789 } }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 1789);

    expect(result.reconciled).toBe(0);
    expect(result.cancelled).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('does not cancel a context-sourced anchor whose confidence is derived', async () => {
    // An API caller passing subjectAnchor: { prNumber } gets source 'context'
    // with confidence 'derived' (subject-anchor-extractor). The claim gate and
    // /start treat that as advisory, so the sweep MUST agree — classifying by
    // source alone here would cancel a task the gate considers claimable, which
    // turns a silent stall into silent destruction.
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({
        id: 'task-ctx-derived',
        status: 'pending',
        subjectAnchor: { version: 1, kind: 'pull_request', prNumber: 42, source: 'context', confidence: 'derived' },
      }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(result.cancelled).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('does not reconcile a url-derived anchor either', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-url', status: 'pending', subjectAnchor: { version: 1, kind: 'pull_request', prNumber: 42, source: 'url', confidence: 'derived' } }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('does not reconcile when the anchor jsonb is missing entirely (fail open)', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-null', status: 'pending', subjectAnchor: null }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('reconciles a context-sourced anchor (the other identifying class)', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-ctx', status: 'pending', subjectAnchor: { version: 1, kind: 'pull_request', prNumber: 42, source: 'context', confidence: 'exact' } }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);
    updateReturning = [{ id: 'task-ctx' }];

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.cancelled).toBe(1);
  });

  it('writes an audit row naming the dead PR and the cancellation', async () => {
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-ci', status: 'pending' })]);
    mockWorkersFindMany.mockResolvedValue([]);
    updateReturning = [{ id: 'task-ci' }];

    await sweepSubjectAnchoredTasks('ws-1', 163);

    expect(mockDbInsert).toHaveBeenCalled();
    const rows = insertValuesSpy.mock.calls[0][0] as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].taskId).toBe('task-ci');
    expect(String(rows[0].note)).toContain('163');
    expect(String(rows[0].note)).toContain('cancelled');
    // The anchor is snapshotted so "why was this cancelled" survives edits.
    expect(rows[0].anchorSnapshot).toEqual({ ...EXACT_ANCHOR });
  });

  it('only audits the rows the UPDATE actually terminated (race-safe)', async () => {
    // A task that started running between the read and the write is excluded by
    // the status guard in the WHERE clause; it must not get an audit row.
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-a', status: 'pending' }),
      makeTask({ id: 'task-b', status: 'pending' }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);
    updateReturning = [{ id: 'task-a' }];

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.cancelled).toBe(1);
    expect(result.reconciled).toBe(1);
    const rows = insertValuesSpy.mock.calls[0][0] as any[];
    expect(rows.map(r => r.taskId)).toEqual(['task-a']);
  });

  it('re-sweeping a cancelled task is a no-op (idempotent)', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-ci', status: 'cancelled', subjectResolution: 'reconciled' }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result).toEqual({ anchored: 1, reconciled: 0, cancelled: 0 });
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('never terminates completed or failed tasks', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'done', status: 'completed' }),
      makeTask({ id: 'dead', status: 'failed' }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.cancelled).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});
