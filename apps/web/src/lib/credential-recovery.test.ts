import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── mocks (before importing the module under test) ────────────────────────────

let selectRows: any[] = [];
const updateWhere = mock((_cond: any) => Promise.resolve());
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

import { requeueAuthFailedTasks, MAX_REQUEUE } from './credential-recovery';

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
  });

  it('requeues tasks whose latest worker died with an auth error', async () => {
    selectRows = [row('task-auth', AUTH_ERR, '2026-07-19T17:00:00Z')];
    const res = await requeueAuthFailedTasks('team-1');
    expect(res.requeued).toEqual(['task-auth']);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('leaves genuinely-failed (non-auth) tasks alone', async () => {
    selectRows = [row('task-build', NON_AUTH_ERR, '2026-07-19T17:00:00Z')];
    const res = await requeueAuthFailedTasks('team-1');
    expect(res.requeued).toEqual([]);
    expect(mockUpdate).not.toHaveBeenCalled();
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
