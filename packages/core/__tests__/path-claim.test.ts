/**
 * Unit tests for packages/core/path-claim.ts
 *
 * Tests: checkPathClaimConflict, rearmWaiter,
 *        registerWaiter (with BFS deadlock detection), getActiveClaimsByWorkspace,
 *        wildcard exclusion, and starvation guard.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── Task / workspace IDs ─────────────────────────────────────────────────────

const WS = 'ws-aaaa';
const TASK_A = 'task-aaaa';
const TASK_B = 'task-bbbb';
const TASK_C = 'task-cccc';
const MISSION_ID = 'mission-xxxx';

// ── DB mock infrastructure ───────────────────────────────────────────────────
//
// path-claim.ts uses:
//   db.query.pathClaims.findMany(...)
//   db.query.pathClaimWaiters.findMany(...)
//   db.update(table).set({}).where(...)
//   db.insert(table).values([...])
//
// We build a minimal stub that routes each call to a per-test queue.

const findManyQueues: Record<string, any[][]> = {
  pathClaims: [],
  pathClaimWaiters: [],
  missionNotes: [],
  workers: [],
  tasks: [],
};

function queueFindMany(table: keyof typeof findManyQueues, rows: any[]) {
  findManyQueues[table].push(rows);
}

function makeFindMany(table: keyof typeof findManyQueues) {
  return mock(async (_opts?: any) => {
    const q = findManyQueues[table];
    if (q.length > 0) return q.shift()!;
    return [];
  });
}

// Track calls for assertions
const updateCalls: any[] = [];
const insertCalls: any[] = [];
const mockExecute = mock(async (..._args: any[]) => ({ rows: [] as any[] }));

function makeUpdateChain(resolvedWith: any[] = []) {
  const whereChain = { returning: mock(() => Promise.resolve(resolvedWith)) };
  const setChain = { where: mock(() => whereChain) };
  return { set: mock(() => setChain) };
}

const mockUpdate = mock((_table: any) => {
  const chain = makeUpdateChain();
  updateCalls.push(chain);
  return chain;
});

// values() → { onConflictDoUpdate } — registerWaiter upserts to re-arm.
const mockOnConflictDoUpdate = mock(async (_cfg: any) => undefined);
function valuesChain(impl: () => Promise<unknown> = async () => undefined) {
  return mock((_v: any) => ({ onConflictDoUpdate: mock(async (cfg: any) => { mockOnConflictDoUpdate(cfg); return impl(); }) }));
}
const mockInsert = mock((_table: any) => {
  const valChain = { values: valuesChain() };
  insertCalls.push(valChain);
  return valChain;
});

// Stateful findMany mocks that are re-created per test
let pathClaimsFindMany = makeFindMany('pathClaims');
let pathClaimWaitersFindMany = makeFindMany('pathClaimWaiters');
let missionNotesFindMany = makeFindMany('missionNotes');
let workersFindMany = makeFindMany('workers');
let tasksFindMany = makeFindMany('tasks');

// ── Module mocks (must come before import) ───────────────────────────────────

import * as realPathOverlap from '../path-overlap';

const mockPathsOverlap = mock((_a: string[], _b: string[]) => false);

mock.module('../db/client', () => ({
  db: {
    query: {
      pathClaims: { findMany: (...args: any[]) => pathClaimsFindMany(...args) },
      pathClaimWaiters: { findMany: (...args: any[]) => pathClaimWaitersFindMany(...args) },
      missionNotes: { findMany: (...args: any[]) => missionNotesFindMany(...args) },
      workers: { findMany: (...args: any[]) => workersFindMany(...args) },
      tasks: { findMany: (...args: any[]) => tasksFindMany(...args) },
    },
    update: (...args: any[]) => mockUpdate(...args),
    insert: (...args: any[]) => mockInsert(...args),
    execute: (...args: any[]) => mockExecute(...args),
  },
}));

mock.module('../db/schema', () => ({
  pathClaims: { workspaceId: 'workspace_id', taskId: 'task_id', releasedAt: 'released_at', id: 'id', path: 'path' },
  pathClaimWaiters: { workspaceId: 'workspace_id', blockingTaskId: 'blocking_task_id', waitingTaskId: 'waiting_task_id', notifiedAt: 'notified_at', id: 'id', registeredAt: 'registered_at', blockedPath: 'blocked_path' },
  missionNotes: { missionId: 'mission_id' },
  workers: { taskId: 'task_id', status: 'status', updatedAt: 'updated_at' },
  tasks: { id: 'id', status: 'status' },
}));

mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ type: 'and', args }),
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  isNull: (a: any) => ({ type: 'isNull', a }),
  lt: (a: any, b: any) => ({ type: 'lt', a, b }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ type: 'sql', strings, values }),
}));

// Only `pathsOverlap` is stubbed. The rest of the module is re-exported for
// real, because a factory that lists one export replaces the whole module and
// every other binding path-claim.ts imports becomes `undefined` — which is not
// a passing test, it is a hidden one. `stripTrailingSep` was already in that
// hole: it is only reached once `pathsOverlap` returns true, so the conflict
// tests below were one un-thrown TypeError away from asserting nothing.
mock.module('../path-overlap', () => ({
  ...realPathOverlap,
  pathsOverlap: mockPathsOverlap,
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import {
  checkPathClaimConflict,
  rearmWaiter,
  registerWaiter,
  getActiveClaimsByWorkspace,
  findStaleClaimHolderTaskIds,
} from '../path-claim';
import { PARKED_HOLDER_TTL_MS } from '../path-claim-ttl';

// ── Helpers ──────────────────────────────────────────────────────────────────

function resetQueues() {
  for (const key of Object.keys(findManyQueues)) {
    findManyQueues[key as keyof typeof findManyQueues] = [];
  }
  updateCalls.length = 0;
  insertCalls.length = 0;
  // Re-create mock functions so call counts reset per test
  pathClaimsFindMany = makeFindMany('pathClaims');
  pathClaimWaitersFindMany = makeFindMany('pathClaimWaiters');
  missionNotesFindMany = makeFindMany('missionNotes');
  workersFindMany = makeFindMany('workers');
  tasksFindMany = makeFindMany('tasks');
  mockPathsOverlap.mockReset();
  mockUpdate.mockReset();
  mockInsert.mockReset();
  mockExecute.mockReset();
  mockExecute.mockResolvedValue({ rows: [] });
}

// ────────────────────────────────────────────────────────────────────────────
// checkPathClaimConflict
// ────────────────────────────────────────────────────────────────────────────

describe('checkPathClaimConflict', () => {
  beforeEach(resetQueues);

  it('returns null when workspace has no active claims', async () => {
    queueFindMany('pathClaims', []);
    const result = await checkPathClaimConflict(WS, TASK_A, ['src/foo.ts']);
    expect(result).toBeNull();
  });

  it('returns null when the only active claims belong to the requesting task', async () => {
    queueFindMany('pathClaims', [
      { taskId: TASK_A, path: 'src/foo.ts' },
      { taskId: TASK_A, path: 'src/bar.ts' },
    ]);
    mockPathsOverlap.mockReturnValue(false);
    const result = await checkPathClaimConflict(WS, TASK_A, ['src/foo.ts']);
    expect(result).toBeNull();
    // pathsOverlap should not have been called (self-claims are excluded)
    expect(mockPathsOverlap).not.toHaveBeenCalled();
  });

  it('returns conflict when another task holds an overlapping path', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_B, path: 'src/shared.ts' }]);
    mockPathsOverlap.mockReturnValue(true);

    const result = await checkPathClaimConflict(WS, TASK_A, ['src/shared.ts']);
    expect(result).not.toBeNull();
    expect(result?.blockingTaskId).toBe(TASK_B);
    expect(result?.blockingPath).toBe('src/shared.ts');
  });

  it('returns null when another task has claims with no overlap', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_B, path: 'packages/utils.ts' }]);
    mockPathsOverlap.mockReturnValue(false);

    const result = await checkPathClaimConflict(WS, TASK_A, ['src/foo.ts']);
    expect(result).toBeNull();
  });

  it('stops at first conflict (returns after first overlapping task)', async () => {
    queueFindMany('pathClaims', [
      { taskId: TASK_B, path: 'src/foo.ts' },
      { taskId: TASK_C, path: 'src/foo.ts' },
    ]);
    // First call returns true → short-circuits
    mockPathsOverlap.mockReturnValueOnce(true).mockReturnValue(false);

    const result = await checkPathClaimConflict(WS, TASK_A, ['src/foo.ts']);
    expect(result?.blockingTaskId).toBe(TASK_B);
  });

  it('ignores self-claims and checks other tasks', async () => {
    queueFindMany('pathClaims', [
      { taskId: TASK_A, path: 'src/own.ts' }, // self — should be skipped
      { taskId: TASK_B, path: 'src/shared.ts' }, // other — should be checked
    ]);
    mockPathsOverlap.mockReturnValue(true);

    const result = await checkPathClaimConflict(WS, TASK_A, ['src/shared.ts']);
    expect(result?.blockingTaskId).toBe(TASK_B);
    // pathsOverlap called exactly once (TASK_A row was excluded)
    expect(mockPathsOverlap).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getActiveClaimsByWorkspace
// ────────────────────────────────────────────────────────────────────────────

describe('getActiveClaimsByWorkspace', () => {
  beforeEach(resetQueues);

  it('returns empty map when no active claims exist', async () => {
    queueFindMany('pathClaims', []);
    const map = await getActiveClaimsByWorkspace(WS);
    expect(map.size).toBe(0);
  });

  it('groups paths by taskId', async () => {
    queueFindMany('pathClaims', [
      { taskId: TASK_A, path: 'src/a.ts' },
      { taskId: TASK_A, path: 'src/b.ts' },
      { taskId: TASK_B, path: 'src/c.ts' },
    ]);

    const map = await getActiveClaimsByWorkspace(WS);
    expect(map.size).toBe(2);
    expect(map.get(TASK_A)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(map.get(TASK_B)).toEqual(['src/c.ts']);
  });

  it('drops a holder parked on a question past the TTL — it no longer defers anyone', async () => {
    queueFindMany('pathClaims', [
      { taskId: TASK_A, path: 'src/a.ts' },
      { taskId: TASK_B, path: 'src/b.ts' },
    ]);
    queueFindMany('workers', [
      { taskId: TASK_A, status: 'waiting_input', updatedAt: new Date(Date.now() - PARKED_HOLDER_TTL_MS - 60_000) },
      { taskId: TASK_B, status: 'running', updatedAt: new Date(Date.now() - PARKED_HOLDER_TTL_MS * 5) },
    ]);

    const map = await getActiveClaimsByWorkspace(WS);
    expect([...map.keys()]).toEqual([TASK_B]);
  });

  it('keeps a parked holder inside the TTL, and a holder with no live worker (PR awaiting merge)', async () => {
    queueFindMany('pathClaims', [
      { taskId: TASK_A, path: 'src/a.ts' },
      { taskId: TASK_B, path: 'src/b.ts' },
    ]);
    queueFindMany('workers', [
      { taskId: TASK_A, status: 'waiting_input', updatedAt: new Date(Date.now() - 60_000) },
    ]);

    const map = await getActiveClaimsByWorkspace(WS);
    expect(map.size).toBe(2);
  });

  it('asks only about live workers of the holding tasks', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_A, path: 'src/a.ts' }]);
    await getActiveClaimsByWorkspace(WS);
    const where = (workersFindMany.mock.calls[0]?.[0] as any)?.where;
    expect(JSON.stringify(where)).toContain('waiting_input');
    expect(JSON.stringify(where)).toContain(TASK_A);
    expect(JSON.stringify(where)).not.toContain('completed');
  });

  it('keeps blocking when the holder lookup fails', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_A, path: 'src/a.ts' }]);
    workersFindMany = mock(async () => { throw new Error('db down'); });
    const map = await getActiveClaimsByWorkspace(WS);
    expect(map.size).toBe(1);
  });

  // ── Terminal-holder backstop (path-claims leak fix) ──────────────────────
  //
  // A leak that this task exists to close: a terminal-transition write that
  // was supposed to release a task's claims (releaseAndNotify) never ran, so
  // the row stays active forever and defers every overlapping sibling task.
  // These read-time filters cannot clear the stale row (only the maintenance
  // sweep does that), but they must stop it from blocking anyone new.

  it('drops a holder whose task itself is terminal, even with a stale live-looking worker', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_A, path: 'src/a.ts' }]);
    // Live-status query (dropExpiredParkedHolders): still reports a live worker —
    // the race this guards is a worker whose own PATCH hasn't landed yet.
    queueFindMany('workers', [{ taskId: TASK_A, status: 'running', updatedAt: new Date() }]);
    queueFindMany('tasks', [{ id: TASK_A, status: 'cancelled' }]);

    const map = await getActiveClaimsByWorkspace(WS);
    expect(map.size).toBe(0);
  });

  it('drops a holder with at least one known worker and none of them live', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_A, path: 'src/a.ts' }]);
    queueFindMany('workers', []); // live-status query: no live worker
    queueFindMany('tasks', [{ id: TASK_A, status: 'pending' }]); // task never flipped terminal
    queueFindMany('workers', [{ taskId: TASK_A, status: 'superseded' }]); // all-workers query

    const map = await getActiveClaimsByWorkspace(WS);
    expect(map.size).toBe(0);
  });

  it('keeps a holder when no worker row is found at all for it — missing data, not proof of staleness', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_A, path: 'src/a.ts' }]);
    queueFindMany('workers', []); // live-status query
    queueFindMany('tasks', [{ id: TASK_A, status: 'pending' }]);
    queueFindMany('workers', []); // all-workers query: nothing found

    const map = await getActiveClaimsByWorkspace(WS);
    expect(map.size).toBe(1);
  });

  it('keeps a holder whose task is non-terminal and has a live worker', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_A, path: 'src/a.ts' }]);
    queueFindMany('workers', [{ taskId: TASK_A, status: 'running', updatedAt: new Date() }]);
    queueFindMany('tasks', [{ id: TASK_A, status: 'assigned' }]);
    queueFindMany('workers', [{ taskId: TASK_A, status: 'running' }]);

    const map = await getActiveClaimsByWorkspace(WS);
    expect(map.size).toBe(1);
  });
});

describe('findStaleClaimHolderTaskIds', () => {
  beforeEach(resetQueues);

  it('returns an empty array when there are no active claims anywhere', async () => {
    queueFindMany('pathClaims', []);
    const stale = await findStaleClaimHolderTaskIds();
    expect(stale).toEqual([]);
    expect(tasksFindMany).not.toHaveBeenCalled();
  });

  it('names a task holding an active claim whose status is terminal', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_A }]);
    queueFindMany('tasks', [{ id: TASK_A, status: 'failed' }]);
    queueFindMany('workers', [{ taskId: TASK_A, status: 'failed' }]);

    const stale = await findStaleClaimHolderTaskIds();
    expect(stale).toEqual([TASK_A]);
  });

  it('names a task with a known worker that is not itself terminal but every worker is', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_A }]);
    queueFindMany('tasks', [{ id: TASK_A, status: 'pending' }]);
    queueFindMany('workers', [{ taskId: TASK_A, status: 'superseded' }]);

    const stale = await findStaleClaimHolderTaskIds();
    expect(stale).toEqual([TASK_A]);
  });

  it('does not name a task that has a live worker', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_A }]);
    queueFindMany('tasks', [{ id: TASK_A, status: 'assigned' }]);
    queueFindMany('workers', [{ taskId: TASK_A, status: 'running' }]);

    const stale = await findStaleClaimHolderTaskIds();
    expect(stale).toEqual([]);
  });

  it('does not name a task with no worker rows found at all', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_A }]);
    queueFindMany('tasks', [{ id: TASK_A, status: 'pending' }]);
    queueFindMany('workers', []);

    const stale = await findStaleClaimHolderTaskIds();
    expect(stale).toEqual([]);
  });
});

describe('checkPathClaimConflict — terminal-holder backstop', () => {
  beforeEach(resetQueues);

  // The acceptance criterion for the path-claims leak fix: a claim held by a
  // task whose worker is terminal must not defer an overlapping pending task,
  // even when the leaked row's own `releaseAndNotify` call never happened.
  it('a claim held by a task whose worker is terminal does not defer an overlapping pending task', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_B, path: 'src/shared.ts' }]);
    queueFindMany('workers', []); // parked-TTL query: no live worker
    queueFindMany('tasks', [{ id: TASK_B, status: 'completed' }]);
    queueFindMany('workers', [{ taskId: TASK_B, status: 'completed' }]); // all-workers query
    mockPathsOverlap.mockReturnValue(true);

    const result = await checkPathClaimConflict(WS, TASK_A, ['src/shared.ts']);
    expect(result).toBeNull();
  });
});

describe('checkPathClaimConflict — parked holder TTL', () => {
  beforeEach(resetQueues);

  it('an overlapping claim held by a task parked past the TTL is not a conflict', async () => {
    queueFindMany('pathClaims', [{ taskId: TASK_B, path: 'src/shared.ts' }]);
    queueFindMany('workers', [
      { taskId: TASK_B, status: 'waiting_input', updatedAt: new Date(Date.now() - PARKED_HOLDER_TTL_MS * 2) },
    ]);
    mockPathsOverlap.mockReturnValue(true);

    const result = await checkPathClaimConflict(WS, TASK_A, ['src/shared.ts']);
    expect(result).toBeNull();
  });
});

describe('rearmWaiter', () => {
  beforeEach(resetQueues);

  // releaseClaims stamps notifiedAt before delivery is attempted, so a failed
  // delivery would otherwise be permanent: no later release finds the waiter,
  // and neither does the starvation check.
  it('clears notifiedAt for one blocking/waiting pair', async () => {
    const chain = makeUpdateChain();
    mockUpdate.mockReturnValue(chain);
    await rearmWaiter(TASK_A, TASK_B);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(chain.set).toHaveBeenCalledWith({ notifiedAt: null });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// registerWaiter — waiter registration and deadlock detection
// ────────────────────────────────────────────────────────────────────────────

describe('registerWaiter', () => {
  beforeEach(resetQueues);

  it('registers a new waiter when no deadlock cycle exists', async () => {
    // BFS from TASK_B: TASK_B waits on nothing → no cycle
    queueFindMany('pathClaimWaiters', []); // BFS level 1: no outgoing edges from TASK_B
    mockInsert.mockReturnValue({ values: valuesChain() });

    const result = await registerWaiter(TASK_A, TASK_B, 'src/foo.ts', WS);
    expect(result).toEqual({ registered: true });
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('returns registered:true and is idempotent on unique constraint violation', async () => {
    queueFindMany('pathClaimWaiters', []); // BFS: no cycle
    // Simulate unique constraint violation
    mockInsert.mockReturnValue({
      values: valuesChain(async () => { throw new Error('connection reset'); }),
    });

    const result = await registerWaiter(TASK_A, TASK_B, 'src/foo.ts', WS);
    expect(result).toEqual({ registered: true }); // error swallowed
  });

  // A waiter woken by a narrowing that collides with the same holder again
  // must be pending again, or the holder's terminal release would skip it.
  it('re-registering the same (blocker, waiter, path) re-arms the row', async () => {
    queueFindMany('pathClaimWaiters', []); // BFS: no cycle
    mockOnConflictDoUpdate.mockClear();
    mockInsert.mockReturnValue({ values: valuesChain() });

    await registerWaiter(TASK_A, TASK_B, 'src/foo.ts', WS);
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(mockOnConflictDoUpdate.mock.calls[0][0].set).toEqual({ notifiedAt: null });
  });

  // registerWaiter(blocking, waiting): "waiting waits on blocking". The BFS
  // walks the BLOCKER's pending waits, looking for the waiter.

  it('detects a direct cycle: B already waits on A, now A tries to wait on B → deadlock', async () => {
    // BFS from TASK_B: TASK_B waits on TASK_A (= the new waiter) → cycle.
    queueFindMany('pathClaimWaiters', [{ blockingTaskId: TASK_A }]);

    const result = await registerWaiter(TASK_B, TASK_A, 'src/foo.ts', WS) as any;
    expect(result.deadlock).toBe(true);
    expect(result.cycle).toEqual([TASK_A, TASK_B, TASK_A]);
    // No insert should happen when deadlock is detected
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('detects a multi-hop cycle: A waits on B, B waits on C, now C tries to wait on A', async () => {
    // registerWaiter(blocking=A, waiting=C). BFS from A:
    queueFindMany('pathClaimWaiters', [{ blockingTaskId: TASK_B }]); // A waits on B
    queueFindMany('pathClaimWaiters', [{ blockingTaskId: TASK_C }]); // B waits on C = the waiter

    const result = await registerWaiter(TASK_A, TASK_C, 'src/z.ts', WS) as any;
    expect(result.deadlock).toBe(true);
    expect(result.cycle).toEqual([TASK_C, TASK_A, TASK_B, TASK_C]);
  });

  it('no deadlock when BFS finds no path back to the waiter', async () => {
    // registerWaiter(blocking=A, waiting=B). A waits on C, C waits on nothing.
    queueFindMany('pathClaimWaiters', [{ blockingTaskId: TASK_C }]);
    queueFindMany('pathClaimWaiters', []);
    mockInsert.mockReturnValue({ values: valuesChain() });

    const result = await registerWaiter(TASK_A, TASK_B, 'src/foo.ts', WS);
    expect(result).toEqual({ registered: true });
  });

  it('walks only pending waits — a notified edge is no longer a wait', async () => {
    queueFindMany('pathClaimWaiters', []);
    mockInsert.mockReturnValue({ values: valuesChain() });
    await registerWaiter(TASK_A, TASK_B, 'src/foo.ts', WS);
    const where = (pathClaimWaitersFindMany.mock.calls[0][0] as any).where;
    expect(where.args).toContainEqual({ type: 'eq', a: 'waiting_task_id', b: TASK_A });
    expect(where.args).toContainEqual({ type: 'isNull', a: 'notified_at' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Wildcard exclusion (advisory-only sentinel)
// ────────────────────────────────────────────────────────────────────────────

describe('checkPathClaimConflict — wildcard task does not block workspace', () => {
  beforeEach(resetQueues);

  it('wildcard-manifest task claims are never inserted, so they cannot block', async () => {
    // If a task has "**" in pathManifest, the route returns 400 before calling acquirePathClaims.
    // So path_claims rows with path="**" can never exist. This test confirms that
    // even if a "**" row somehow existed, pathsOverlap([specific], ["**"]) would be
    // called — but since the "**" check runs before acquisition, this is defence-in-depth.
    //
    // From the route layer: check_path_claim(['**']) → 400 before reaching this function.
    // The invariant is: path_claims rows never contain "**".

    // Confirm: if DB has no "**" rows, conflict check returns null.
    queueFindMany('pathClaims', [{ taskId: TASK_B, path: 'src/specific.ts' }]);
    mockPathsOverlap.mockReturnValue(false);

    const result = await checkPathClaimConflict(WS, TASK_A, ['src/other.ts']);
    expect(result).toBeNull();
  });
});

// insertClaims / appendPathManifest were replaced by acquirePathClaims; it,
// narrowPathClaims, releaseClaims and claimObservedPaths are covered against a
// table model in path-claim-ownership.test.ts.
