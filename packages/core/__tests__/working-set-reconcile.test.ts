/**
 * Server half of the authoritative working set (path-claim-ownership.md):
 * one delta → one bulk acquisition + one exact release, bounded statements
 * regardless of size, idempotent on repeat, and the PR handoff that keeps an
 * open PR's actual changed files on the overlap surface after its worker ends.
 *
 * The lease primitives are stubbed on an in-memory lease table: their own SQL
 * is pinned by path-claim-ownership.test.ts.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/working-set-reconcile.test.ts
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const WS = '00000000-0000-4000-8000-00000000aaaa';
const TASK = '00000000-0000-4000-8000-0000000000a1';
const SIBLING = '00000000-0000-4000-8000-0000000000b1';

interface Lease { id: string; taskId: string; path: string; releasedAt: Date | null }
const leases: Lease[] = [];
let seq = 0;
let taskOpen = true;
let taskRow: { pathManifest: string[] | null } = { pathManifest: null };
const taskUpdates: any[] = [];

const acquireCalls: any[] = [];
const releaseCalls: any[] = [];

mock.module('../path-claim', () => ({
  acquirePathClaims: mock(async (input: { workspaceId: string; taskId: string; paths: string[]; declare: boolean }) => {
    acquireCalls.push(input);
    if (!taskOpen) return { kind: 'task_closed' };
    const inserted: string[] = [];
    const insertedIds: string[] = [];
    const blocked: Array<{ path: string; blockingTaskId: string; blockingPath: string }> = [];
    for (const p of input.paths) {
      const holder = leases.find(l => !l.releasedAt && l.taskId !== input.taskId && l.path === p);
      if (holder) { blocked.push({ path: p, blockingTaskId: holder.taskId, blockingPath: holder.path }); continue; }
      if (leases.some(l => !l.releasedAt && l.taskId === input.taskId && l.path === p)) continue;
      const id = `c${++seq}`;
      leases.push({ id, taskId: input.taskId, path: p, releasedAt: null });
      inserted.push(p); insertedIds.push(id);
    }
    return { kind: 'acquired', inserted, insertedIds, blocked, pathManifest: null, revision: 1 };
  }),
  releaseLeaseRows: mock(async (input: { workspaceId: string; taskId: string; leaseIds: string[]; keepStatuses: string[] }) => {
    releaseCalls.push(input);
    const releasedPaths: string[] = [];
    for (const l of leases) {
      if (input.leaseIds.includes(l.id) && l.taskId === input.taskId && !l.releasedAt) {
        l.releasedAt = new Date();
        releasedPaths.push(l.path);
      }
    }
    return {
      kind: 'released',
      result: { workspaceId: input.workspaceId, releasedPaths, notifiedWaiters: ['waiter-1'], waiters: releasedPaths.map(p => ({ waitingTaskId: 'waiter-1', blockedPath: p })) },
    };
  }),
}));

mock.module('../db/client', () => ({
  db: {
    query: {
      pathClaims: {
        findMany: mock(async (opts: any) => {
          // Only this task's active rows are ever asked for here.
          return leases.filter(l => !l.releasedAt && l.taskId === TASK).map(l => ({ id: l.id, path: l.path }));
        }),
      },
      tasks: { findFirst: mock(async () => taskRow) },
    },
    update: mock(() => ({ set: mock((vals: any) => { taskUpdates.push(vals); return { where: mock(async () => {}) }; }) })),
  },
}));

import { reconcileWorkingSet, planPrHandoff, promoteLeasesToPrScope, leasablePaths, workingSetRecord, workingSetSizeBucket } from '../working-set';

beforeEach(() => {
  leases.length = 0; seq = 0; taskOpen = true;
  taskRow = { pathManifest: null };
  taskUpdates.length = 0; acquireCalls.length = 0; releaseCalls.length = 0;
});

const delta = (over: Partial<{ generation: number; add: string[]; remove: string[]; complete: boolean; includeHeld: boolean }> = {}) => ({
  generation: 1, add: [], remove: [], complete: true, ...over,
});

describe('reconcileWorkingSet', () => {
  it('2,000 added paths are one acquisition statement and every one is leased', async () => {
    const add = Array.from({ length: 2000 }, (_, i) => `src/f${i}.ts`);
    const r = await reconcileWorkingSet({ workspaceId: WS, taskId: TASK, delta: delta({ add }) });
    expect(acquireCalls).toHaveLength(1);
    expect(acquireCalls[0].paths).toHaveLength(2000);
    expect(acquireCalls[0].declare).toBe(false);
    expect(r.ack.acquired).toHaveLength(2000);
    expect(r.ack.heldCount).toBe(2000);
    expect(r.ack.coverage).toBe('complete');
    expect(r.sizeBucket).toBe('<=2k');
  });

  it('a sibling holding path #1500 comes back blocked with the holder, and coverage is not complete', async () => {
    leases.push({ id: 'x', taskId: SIBLING, path: 'src/f1500.ts', releasedAt: null });
    const add = Array.from({ length: 2000 }, (_, i) => `src/f${i}.ts`);
    const r = await reconcileWorkingSet({ workspaceId: WS, taskId: TASK, delta: delta({ add }) });
    expect(r.ack.blocked).toEqual([{ path: 'src/f1500.ts', blockingTaskId: SIBLING, blockingTaskTitle: null, blockingPath: 'src/f1500.ts' }]);
    expect(r.ack.acquired).toHaveLength(1999);
    expect(r.ack.coverage).toBe('blocked');
  });

  it('the same delta twice acquires nothing new, releases nothing twice, and costs the same statements', async () => {
    const d = delta({ add: ['a.ts', 'b.ts'] });
    const first = await reconcileWorkingSet({ workspaceId: WS, taskId: TASK, delta: d });
    const second = await reconcileWorkingSet({ workspaceId: WS, taskId: TASK, delta: d });
    expect(first.ack.acquired).toEqual(['a.ts', 'b.ts']);
    expect(second.ack.acquired).toEqual([]);
    expect(second.ack.heldCount).toBe(2);
    expect(second.ack.coverage).toBe('complete');
    expect(acquireCalls).toHaveLength(2);
    expect(releaseCalls).toHaveLength(0);
  });

  it('a reverted path releases exactly its lease and surfaces the woken waiter', async () => {
    await reconcileWorkingSet({ workspaceId: WS, taskId: TASK, delta: delta({ add: ['a.ts', 'b.ts'] }) });
    const r = await reconcileWorkingSet({ workspaceId: WS, taskId: TASK, delta: delta({ generation: 2, remove: ['b.ts'] }) });
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0].keepStatuses).toEqual([]);
    expect(r.ack.released).toEqual(['b.ts']);
    expect(r.ack.heldCount).toBe(1);
    expect(r.release?.notifiedWaiters).toEqual(['waiter-1']);
    // Removing a path the task never held is a no-op, not a statement.
    const again = await reconcileWorkingSet({ workspaceId: WS, taskId: TASK, delta: delta({ generation: 3, remove: ['b.ts', 'zzz.ts'] }) });
    expect(releaseCalls).toHaveLength(1);
    expect(again.ack.released).toEqual([]);
  });

  it('a closed task leases nothing and the ack says so instead of claiming coverage', async () => {
    taskOpen = false;
    const r = await reconcileWorkingSet({ workspaceId: WS, taskId: TASK, delta: delta({ add: ['a.ts'] }) });
    expect(r.ack.applied).toBe(false);
    expect(r.ack.coverage).toBe('partial');
    expect(r.ack.acquired).toEqual([]);
  });

  it('includeHeld returns the server truth for a restarted runner to seed from', async () => {
    leases.push({ id: 'own', taskId: TASK, path: 'declared/dir', releasedAt: null });
    const r = await reconcileWorkingSet({ workspaceId: WS, taskId: TASK, delta: delta({ add: ['a.ts'], includeHeld: true }) });
    expect(r.ack.heldPaths).toEqual(['a.ts', 'declared/dir']);
  });

  it('regenerable files and the repo-wide sentinel are never part of the set, and a read-only review leases nothing', async () => {
    expect(leasablePaths(['**', 'docs/specs/INDEX.md', 'src/a.ts', ' src/a.ts/ ', ''])).toEqual(['src/a.ts']);
    const r = await reconcileWorkingSet({ workspaceId: WS, taskId: TASK, delta: delta({ add: ['src/a.ts'] }), readOnly: true });
    expect(acquireCalls).toHaveLength(0);
    expect(r.ack.acquired).toEqual([]);
  });

  it('size buckets are the instrumentation the compression decision waits on', () => {
    expect(workingSetSizeBucket(0)).toBe('<=50');
    expect(workingSetSizeBucket(50)).toBe('<=50');
    expect(workingSetSizeBucket(500)).toBe('<=500');
    expect(workingSetSizeBucket(2000)).toBe('<=2k');
    expect(workingSetSizeBucket(2001)).toBe('>2k');
  });

  it('the stored record is bounded: counts and a sample, never the set', () => {
    const blocked = Array.from({ length: 50 }, (_, i) => ({ path: `p${i}`, blockingTaskId: SIBLING, blockingTaskTitle: null, blockingPath: `p${i}` }));
    const rec = workingSetRecord({
      ack: { generation: 7, acquired: Array(2000).fill('x'), blocked, released: [], heldCount: 2000, applied: true, coverage: 'blocked' },
      checkpoint: 'pre_push', workerId: 'w1', now: new Date('2026-10-07T00:00:00Z'),
    });
    expect(rec).toMatchObject({ generation: 7, coverage: 'blocked', heldCount: 2000, blockedCount: 50, checkpoint: 'pre_push', workerId: 'w1' });
    expect(rec.blockedSample).toHaveLength(10);
    expect(JSON.stringify(rec).length).toBeLessThan(2000);
  });
});

describe('PR handoff: leases become the open-PR overlap surface', () => {
  it('a repo-wide or absent manifest becomes the concrete lease set', () => {
    expect(planPrHandoff(['**'], ['b.ts', 'a.ts'])).toEqual({ next: ['b.ts', 'a.ts'], promoted: ['b.ts', 'a.ts'], replacedSentinel: true });
    expect(planPrHandoff(null, ['a.ts'])).toEqual({ next: ['a.ts'], promoted: ['a.ts'], replacedSentinel: true });
  });

  it('a concrete manifest gains only what it does not already cover', () => {
    expect(planPrHandoff(['apps/web/', 'x.ts'], ['apps/web/a.ts', 'x.ts', 'y.ts'])).toEqual({
      next: ['apps/web', 'x.ts', 'y.ts'], promoted: ['y.ts'], replacedSentinel: false,
    });
    expect(planPrHandoff(['x.ts'], ['x.ts'])).toBeNull();
    expect(planPrHandoff(['**'], [])).toBeNull();
  });

  it('promotes held leases into the manifest, records the handoff and bumps the ownership revision', async () => {
    leases.push({ id: 'l1', taskId: TASK, path: 'src/a.ts', releasedAt: null });
    leases.push({ id: 'l2', taskId: TASK, path: 'src/b.ts', releasedAt: null });
    taskRow = { pathManifest: ['**'] };
    const rec = await promoteLeasesToPrScope({ workspaceId: WS, taskId: TASK, workerId: 'w1', prNumber: 42 });
    expect(rec).toMatchObject({ promoted: 2, replacedSentinel: true, prNumber: 42, workerId: 'w1' });
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0].pathManifest).toEqual(['src/a.ts', 'src/b.ts']);
    expect(taskUpdates[0].pathClaimRevision).toBeDefined();
  });

  it('nothing held: nothing written', async () => {
    taskRow = { pathManifest: ['**'] };
    expect(await promoteLeasesToPrScope({ workspaceId: WS, taskId: TASK, workerId: null, prNumber: null })).toBeNull();
    expect(taskUpdates).toHaveLength(0);
  });
});
