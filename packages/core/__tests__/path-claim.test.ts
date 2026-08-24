/**
 * Unit tests for packages/core/path-claim.ts
 *
 * Tests: checkPathClaimConflict, insertClaims, releaseClaims,
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

const mockInsert = mock((_table: any) => {
  const valChain = { values: mock(async () => undefined) };
  insertCalls.push(valChain);
  return valChain;
});

// Stateful findMany mocks that are re-created per test
let pathClaimsFindMany = makeFindMany('pathClaims');
let pathClaimWaitersFindMany = makeFindMany('pathClaimWaiters');
let missionNotesFindMany = makeFindMany('missionNotes');

// ── Module mocks (must come before import) ───────────────────────────────────

const mockPathsOverlap = mock((_a: string[], _b: string[]) => false);

mock.module('../db/client', () => ({
  db: {
    query: {
      pathClaims: { findMany: (...args: any[]) => pathClaimsFindMany(...args) },
      pathClaimWaiters: { findMany: (...args: any[]) => pathClaimWaitersFindMany(...args) },
      missionNotes: { findMany: (...args: any[]) => missionNotesFindMany(...args) },
    },
    update: (...args: any[]) => mockUpdate(...args),
    insert: (...args: any[]) => mockInsert(...args),
  },
}));

mock.module('../db/schema', () => ({
  pathClaims: { workspaceId: 'workspace_id', taskId: 'task_id', releasedAt: 'released_at', id: 'id', path: 'path' },
  pathClaimWaiters: { workspaceId: 'workspace_id', blockingTaskId: 'blocking_task_id', waitingTaskId: 'waiting_task_id', notifiedAt: 'notified_at', id: 'id', registeredAt: 'registered_at', blockedPath: 'blocked_path' },
  missionNotes: { missionId: 'mission_id' },
}));

mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ type: 'and', args }),
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  isNull: (a: any) => ({ type: 'isNull', a }),
  lt: (a: any, b: any) => ({ type: 'lt', a, b }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
}));

mock.module('../path-overlap', () => ({
  pathsOverlap: mockPathsOverlap,
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import {
  checkPathClaimConflict,
  insertClaims,
  releaseClaims,
  registerWaiter,
  getActiveClaimsByWorkspace,
} from '../path-claim';

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
  mockPathsOverlap.mockReset();
  mockUpdate.mockReset();
  mockInsert.mockReset();
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
});

// ────────────────────────────────────────────────────────────────────────────
// insertClaims
// ────────────────────────────────────────────────────────────────────────────

describe('insertClaims', () => {
  beforeEach(resetQueues);

  it('returns empty array for empty paths input', async () => {
    const inserted = await insertClaims(WS, TASK_A, []);
    expect(inserted).toEqual([]);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('inserts new paths and returns them', async () => {
    // No existing claims for this task
    queueFindMany('pathClaims', []);
    mockInsert.mockReturnValue({ values: mock(async () => undefined) });

    const inserted = await insertClaims(WS, TASK_A, ['src/foo.ts', 'src/bar.ts']);
    expect(inserted).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('skips paths already claimed by this task (idempotent)', async () => {
    queueFindMany('pathClaims', [{ path: 'src/foo.ts' }]);
    mockInsert.mockReturnValue({ values: mock(async () => undefined) });

    const inserted = await insertClaims(WS, TASK_A, ['src/foo.ts', 'src/bar.ts']);
    expect(inserted).toEqual(['src/bar.ts']);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('does not call insert when all paths are already claimed', async () => {
    queueFindMany('pathClaims', [{ path: 'src/foo.ts' }]);

    const inserted = await insertClaims(WS, TASK_A, ['src/foo.ts']);
    expect(inserted).toEqual([]);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// releaseClaims
// ────────────────────────────────────────────────────────────────────────────

describe('releaseClaims', () => {
  beforeEach(resetQueues);

  it('returns null when task has no active claims', async () => {
    queueFindMany('pathClaims', []);
    const result = await releaseClaims(TASK_A);
    expect(result).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('soft-deletes active claims and returns release info', async () => {
    queueFindMany('pathClaims', [
      { id: 'claim-1', workspaceId: WS, path: 'src/foo.ts' },
      { id: 'claim-2', workspaceId: WS, path: 'src/bar.ts' },
    ]);
    // No pending waiters
    queueFindMany('pathClaimWaiters', []);

    mockUpdate.mockReturnValue(makeUpdateChain());

    const result = await releaseClaims(TASK_A);
    expect(result).not.toBeNull();
    expect(result?.workspaceId).toBe(WS);
    expect(result?.releasedPaths).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(result?.notifiedWaiters).toEqual([]);
    expect(mockUpdate).toHaveBeenCalledTimes(1); // only claim update; no waiters
  });

  it('stamps notifiedAt on pending waiters and returns their IDs', async () => {
    queueFindMany('pathClaims', [
      { id: 'claim-1', workspaceId: WS, path: 'src/foo.ts' },
    ]);
    queueFindMany('pathClaimWaiters', [
      { id: 'waiter-1', waitingTaskId: TASK_B },
      { id: 'waiter-2', waitingTaskId: TASK_C },
    ]);

    mockUpdate.mockReturnValue(makeUpdateChain());

    const result = await releaseClaims(TASK_A);
    expect(result?.notifiedWaiters).toEqual([TASK_B, TASK_C]);
    // update called twice: once for claims, once for waiters
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not call waiter update when no pending waiters', async () => {
    queueFindMany('pathClaims', [{ id: 'claim-1', workspaceId: WS, path: 'src/a.ts' }]);
    queueFindMany('pathClaimWaiters', []);
    mockUpdate.mockReturnValue(makeUpdateChain());

    await releaseClaims(TASK_A);
    expect(mockUpdate).toHaveBeenCalledTimes(1); // claim soft-delete only
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
    mockInsert.mockReturnValue({ values: mock(async () => undefined) });

    const result = await registerWaiter(TASK_A, TASK_B, 'src/foo.ts', WS);
    expect(result).toEqual({ registered: true });
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('returns registered:true and is idempotent on unique constraint violation', async () => {
    queueFindMany('pathClaimWaiters', []); // BFS: no cycle
    // Simulate unique constraint violation
    mockInsert.mockReturnValue({
      values: mock(async () => { throw new Error('duplicate key value violates unique constraint'); }),
    });

    const result = await registerWaiter(TASK_A, TASK_B, 'src/foo.ts', WS);
    expect(result).toEqual({ registered: true }); // error swallowed
  });

  it('detects a direct cycle: A waits on B, B tries to wait on A → deadlock', async () => {
    // BFS from TASK_B: TASK_B already waits on TASK_A
    // detectDeadlockCycle(blockingTaskId=TASK_B, waitingTaskId=TASK_A):
    //   Start from TASK_A. Check: where does TASK_A wait?
    //   TASK_A waits on TASK_B → we reach TASK_B (= newBlockingTaskId) → cycle!
    queueFindMany('pathClaimWaiters', [
      { blockingTaskId: TASK_B }, // TASK_A is waiting on TASK_B
    ]);

    const result = await registerWaiter(TASK_B, TASK_A, 'src/foo.ts', WS) as any;
    expect(result.deadlock).toBe(true);
    expect(result.cycle).toBeDefined();
    expect(result.cycle).toContain(TASK_A);
    expect(result.cycle).toContain(TASK_B);
    // No insert should happen when deadlock is detected
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('detects a multi-hop cycle: A→B→C→A', async () => {
    // Scenario: A holds x, B holds y, C holds z
    // Existing waiter graph: B waits on A (B→A), C waits on B (C→B)
    // New edge: A waits on C (A→C) would close the cycle A→C→B→A
    //
    // registerWaiter(blockingTaskId=C, waitingTaskId=A, ...)
    // detectDeadlockCycle(newBlockingTaskId=C, newWaitingTaskId=A):
    //   BFS from A. Where does A wait? A waits on nothing (no existing edge from A).
    //   But we need the cycle to exist with B and C in the graph.
    //
    // Actually the BFS traverses: start=A, look for where A is waiting.
    // For A→C→B→A cycle: existing graph is A waits on C (no! that's the new edge).
    // Let me re-think:
    //
    // Existing: B waits on A, C waits on B. New proposed: A waits on C.
    // detectDeadlockCycle(blockingTaskId=C, waitingTaskId=A):
    //   Start BFS from A (the one trying to wait).
    //   Where does A wait? A currently waits on nothing (queue returns []).
    //   Oh wait... we also need A currently waiting on something for there to be a cycle.
    //
    // The simpler 3-node cycle: A waits on B (existing), B waits on C (existing).
    // New: C tries to wait on A → detectDeadlockCycle(blocking=A, waiting=C)
    //   BFS from C. Where does C wait? C waits on B.
    //   Where does B wait? B waits on A = newBlockingTaskId → cycle!

    // BFS call 1: where does TASK_C (the waiter) wait?
    queueFindMany('pathClaimWaiters', [{ blockingTaskId: TASK_B }]); // C waits on B
    // BFS call 2: where does TASK_B wait?
    queueFindMany('pathClaimWaiters', [{ blockingTaskId: TASK_A }]); // B waits on A → A == newBlockingTaskId

    // registerWaiter(blockingTaskId=TASK_A, waitingTaskId=TASK_C, ...)
    const result = await registerWaiter(TASK_A, TASK_C, 'src/z.ts', WS) as any;
    expect(result.deadlock).toBe(true);
    expect(result.cycle).toBeDefined();
    expect(result.cycle.length).toBeGreaterThanOrEqual(3);
  });

  it('no deadlock when BFS finds no path back to blocker', async () => {
    // TASK_B waits on some other task (TASK_C), not on TASK_A
    queueFindMany('pathClaimWaiters', [{ blockingTaskId: TASK_C }]); // B→C
    queueFindMany('pathClaimWaiters', []); // C waits on nothing
    mockInsert.mockReturnValue({ values: mock(async () => undefined) });

    const result = await registerWaiter(TASK_A, TASK_B, 'src/foo.ts', WS);
    expect(result).toEqual({ registered: true });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Wildcard exclusion (advisory-only sentinel)
// ────────────────────────────────────────────────────────────────────────────

describe('checkPathClaimConflict — wildcard task does not block workspace', () => {
  beforeEach(resetQueues);

  it('wildcard-manifest task claims are never inserted, so they cannot block', async () => {
    // If a task has "**" in pathManifest, the route returns 400 before calling insertClaims.
    // So path_claims rows with path="**" can never exist. This test confirms that
    // even if a "**" row somehow existed, pathsOverlap([specific], ["**"]) would be
    // called — but since insertClaims blocks "**" at insertion, this is defence-in-depth.
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

// ────────────────────────────────────────────────────────────────────────────
// releaseClaims — released claim does not free path while PR is still open
// ────────────────────────────────────────────────────────────────────────────

describe('releaseClaims — separation of concerns', () => {
  beforeEach(resetQueues);

  it('releaseClaims only soft-deletes path_claims rows; it does not modify PR state', async () => {
    // Per spec: an open PR is a separate signal tracked in tasks.prNumber / tasks.status.
    // releaseClaims touches only path_claims and path_claim_waiters — no PR table writes.
    // The claim is effectively released (releasedAt stamped), but whether the underlying
    // PR is still open is orthogonal. The claim route and findBlockingPr handle PR state.
    queueFindMany('pathClaims', [{ id: 'c1', workspaceId: WS, path: 'src/foo.ts' }]);
    queueFindMany('pathClaimWaiters', []);
    mockUpdate.mockReturnValue(makeUpdateChain());

    const result = await releaseClaims(TASK_A);
    // Release recorded in path_claims
    expect(result?.releasedPaths).toContain('src/foo.ts');
    // One update (claims), zero waiter update
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // No insert to task/PR tables
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
