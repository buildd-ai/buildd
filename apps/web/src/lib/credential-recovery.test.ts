import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── mocks (before importing the module under test) ────────────────────────────

let selectRows: any[] = [];
// The guarded flip returns the rows it moved; by default every failed task read.
let flippedIds: string[] | null = null;
const updateWhere = mock((_cond: any) => ({
  returning: async () => (flippedIds ?? [...new Set(selectRows.map((r: any) => r.taskId))]).map(id => ({ id })),
}));
const updateSet = mock(() => ({ where: updateWhere }));
const mockUpdate = mock(() => ({ set: updateSet }));

// db.select(...).from(...).innerJoin(...).leftJoin(...).where(...) → Promise<rows>
function makeSelectChain() {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => Promise.resolve(selectRows),
  };
  return chain;
}
const mockSelect = mock(() => makeSelectChain());

mock.module('@buildd/core/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', workspaceId: 'workspace_id', status: 'status', updatedAt: 'updated_at' },
  workers: { taskId: 'task_id', error: 'error', createdAt: 'created_at' },
  workspaces: { id: 'id', teamId: 'team_id' },
}));

mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ __eq: { f, v } }),
  and: (...c: any[]) => ({ __and: c }),
  gt: (f: any, v: any) => ({ __gt: { f, v } }),
  inArray: (f: any, v: any[]) => ({ __inArray: { f, v } }),
  sql: Object.assign((s: any) => ({ __sql: s }), { raw: (s: string) => ({ __raw: s }) }),
}));

// Real classifier (pure) is used — not mocked.

// The requeue wakes through the dispatch authority. Full export surface:
// mock.module is process-global.
const mockWakeTasks = mock(async (_ids: readonly string[], _cause: string) => {});
mock.module('@/lib/dispatch-authority', () => ({
  wakeTask: mock(async () => {}),
  wakeTasks: mockWakeTasks,
  announceTaskCreated: mock(async () => {}),
  kickDispatch: mock(() => {}),
  enqueueTaskDispatch: mock(async () => {}),
  drainDispatchOutbox: mock(async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 })),
  deliverTaskDispatch: mock(async () => 'pusher'),
  routeForCause: mock(() => ({ event: 'task.unblocked', legacyDefault: false, legacyUnfilteredRunnerPreference: false })),
  webhookWants: mock(() => false),
  primaryCause: mock((_c: unknown, fallback: unknown) => fallback),
  reseedDispatchTimer: mock(async () => {}),
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
}));

// Held tasks (failure-incident-recovery §18.3) are released by their one writer.
let releasedIds: string[] = [];
const mockReleaseCredentialHolds = mock(async (_input: any) => releasedIds);
mock.module('@/lib/task-recovery-hold', () => ({ releaseCredentialHolds: mockReleaseCredentialHolds }));

import { requeueAuthFailedTasks, requeueFailedTasks, MAX_REQUEUE } from './credential-recovery';

const AUTH_ERR = 'Your access token could not be refreshed because you have since logged out or signed in to another account.';
const NON_AUTH_ERR = 'Command failed: tsc exited with code 2';

function row(taskId: string, workerError: string | null, createdAt: string) {
  return { taskId, taskUpdatedAt: new Date(), workerError, workerCreatedAt: new Date(createdAt) };
}

describe('requeueAuthFailedTasks', () => {
  beforeEach(() => {
    selectRows = [];
    mockUpdate.mockClear();
    updateSet.mockClear();
    updateWhere.mockClear();
    mockWakeTasks.mockClear();
  });

  it('requeues tasks whose latest worker died with an auth error', async () => {
    selectRows = [row('task-auth', AUTH_ERR, '2026-07-19T17:00:00Z')];
    const res = await requeueAuthFailedTasks('team-1');
    expect(res.requeued).toEqual(['task-auth']);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // Woken now, labelled with why: the credential that failed them is back.
    expect(mockWakeTasks.mock.calls).toEqual([[['task-auth'], 'credential.restored']]);
  });

  it('leaves genuinely-failed (non-auth) tasks alone', async () => {
    selectRows = [row('task-build', NON_AUTH_ERR, '2026-07-19T17:00:00Z')];
    const res = await requeueAuthFailedTasks('team-1');
    expect(res.requeued).toEqual([]);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockWakeTasks).not.toHaveBeenCalled();
  });

  it('judges a task by its LATEST worker error, not an earlier one', async () => {
    // Earlier worker failed on auth, but the latest worker failed on a real bug →
    // the task is a genuine failure now, do not requeue.
    selectRows = [
      row('task-x', AUTH_ERR, '2026-07-19T10:00:00Z'),
      row('task-x', NON_AUTH_ERR, '2026-07-19T17:00:00Z'),
    ];
    const res = await requeueAuthFailedTasks('team-1');
    expect(res.requeued).toEqual([]);
  });

  it('requeues when the latest worker is the auth failure (earlier was a bug)', async () => {
    selectRows = [
      row('task-y', NON_AUTH_ERR, '2026-07-19T10:00:00Z'),
      row('task-y', AUTH_ERR, '2026-07-19T17:00:00Z'),
    ];
    const res = await requeueAuthFailedTasks('team-1');
    expect(res.requeued).toEqual(['task-y']);
  });

  it('caps the number requeued and reports the overflow', async () => {
    selectRows = Array.from({ length: MAX_REQUEUE + 5 }, (_, i) =>
      row(`task-${i}`, AUTH_ERR, '2026-07-19T17:00:00Z'));
    const res = await requeueAuthFailedTasks('team-1');
    expect(res.requeued.length).toBe(MAX_REQUEUE);
    expect(res.skippedOverCap).toBe(5);
  });

  it('returns empty without an UPDATE when there are no failed tasks', async () => {
    selectRows = [];
    const res = await requeueAuthFailedTasks('team-1');
    expect(res.requeued).toEqual([]);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('requeueAuthFailedTasks — credential holds', () => {
  beforeEach(() => {
    selectRows = [];
    releasedIds = [];
    mockReleaseCredentialHolds.mockClear();
    mockWakeTasks.mockClear();
  });

  it('a stored healthy credential releases the team\'s held tasks too (AC-19)', async () => {
    releasedIds = ['task-held'];
    const result = await requeueAuthFailedTasks('team-1');
    expect(mockReleaseCredentialHolds).toHaveBeenCalledWith({ teamId: 'team-1', by: 'credential.restored' });
    expect(result.released).toEqual(['task-held']);
  });

  it('a release that throws does not undo the failed-task requeue', async () => {
    selectRows = [row('task-auth', AUTH_ERR, '2026-07-19T17:00:00Z')];
    mockReleaseCredentialHolds.mockImplementationOnce(async () => { throw new Error('db down'); });
    const result = await requeueAuthFailedTasks('team-1');
    expect(result.requeued).toEqual(['task-auth']);
    expect(result.released).toEqual([]);
  });
});

describe('requeueFailedTasks — the shared requeue writer', () => {
  beforeEach(() => {
    selectRows = [];
    flippedIds = null;
    mockUpdate.mockClear();
    mockWakeTasks.mockClear();
  });

  it('wakes only the tasks the guarded flip actually moved', async () => {
    flippedIds = ['task-a'];
    const ids = await requeueFailedTasks(['task-a', 'task-b'], 'task.requeued');
    expect(ids).toEqual(['task-a']);
    expect(mockWakeTasks.mock.calls).toEqual([[['task-a'], 'task.requeued']]);
  });

  it('a task no longer failed is not woken (nothing flipped)', async () => {
    flippedIds = [];
    expect(await requeueFailedTasks(['task-a'], 'task.requeued')).toEqual([]);
    expect(mockWakeTasks).not.toHaveBeenCalled();
  });

  it('no ids: no write', async () => {
    expect(await requeueFailedTasks([], 'task.requeued')).toEqual([]);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
