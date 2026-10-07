import { describe, it, expect, mock, beforeEach } from 'bun:test';

// In-memory stand-in for the two tables the helper touches. The worker row is
// overwritten on every registration, exactly like PATCH /api/workers/[id].
const registry: Array<{ id: number; taskId: string; workerId: string | null; prUrl: string; prNumber: number | null; state: string }> = [];
const workerRow = { taskId: 't1', prUrl: null as string | null, prNumber: null as number | null, mergedAt: null as Date | null, prLifecycleStatus: null as string | null };
const TR = { __t: 'task_pull_requests', id: 'id', taskId: 'taskId', prUrl: 'prUrl', state: 'state' };
const W = { __t: 'workers', id: 'id', taskId: 'taskId', prUrl: 'prUrl', prNumber: 'prNumber', mergedAt: 'mergedAt', prLifecycleStatus: 'prLifecycleStatus' };

mock.module('drizzle-orm', () => ({
  eq: (f: string, v: unknown) => (r: any) => r[f] === v,
  ne: (f: string, v: unknown) => (r: any) => r[f] !== v,
  and: (...p: Array<(r: any) => boolean>) => (r: any) => p.every(x => x(r)),
}));
mock.module('@buildd/core/db/schema', () => ({ taskPullRequests: TR, workers: W }));
mock.module('@/lib/dep-gate-contract', () => ({
  isTerminalPrLifecycle: (s: string | null) => s === 'merged' || s === 'closed' || s === 'unresolvable',
}));
mock.module('@buildd/core/db', () => ({
  db: {
    insert: (_t: any) => ({
      values: (v: any) => ({
        onConflictDoNothing: async () => {
          if (!registry.some(r => r.taskId === v.taskId && r.prUrl === v.prUrl)) registry.push({ id: registry.length + 1, state: 'open', ...v });
        },
      }),
    }),
    update: (_t: any) => ({
      set: (v: any) => ({ where: async (p: any) => { registry.filter(p).forEach(r => Object.assign(r, v)); } }),
    }),
    select: (_c?: any) => ({
      from: (t: any) => ({
        where: (p: any) => {
          const rows = t === TR ? registry.filter(p) : [workerRow].filter(p);
          return Object.assign(Promise.resolve(rows), { limit: async (n: number) => rows.slice(0, n) });
        },
      }),
    }),
  },
}));

const { recordTaskPr, markTaskPrState, otherOpenPrsOfTask, lastPrSettledWithMerge } = await import('./task-open-prs');

const url = (n: number) => `https://github.com/o/r/pull/${n}`;
/** What each registration path does: overwrite the worker row, record in the registry. */
async function register(n: number) {
  workerRow.prUrl = url(n);
  workerRow.prNumber = n;
  await recordTaskPr({ taskId: 't1', workerId: 'w1', prUrl: url(n), prNumber: n });
}
async function merge(n: number) {
  await markTaskPrState(url(n), 'merged');
}

describe('open sibling PRs of a task (one worker, three stacked PRs)', () => {
  beforeEach(() => {
    registry.length = 0;
    Object.assign(workerRow, { prUrl: null, prNumber: null, mergedAt: null, prLifecycleStatus: null });
  });

  it('first merge sees the two others although the worker row holds only the last', async () => {
    await register(1); await register(2); await register(3);
    expect(workerRow.prNumber).toBe(3);
    await merge(1);
    expect((await otherOpenPrsOfTask('t1', { prUrl: url(1) })).sort()).toEqual([url(2), url(3)]);
  });

  it('only the last merge leaves nothing open', async () => {
    await register(1); await register(2); await register(3);
    await merge(1);
    await merge(2);
    expect(await otherOpenPrsOfTask('t1', { prUrl: url(2) })).toEqual([url(3)]);
    await merge(3);
    expect(await otherOpenPrsOfTask('t1', { prUrl: url(3) })).toEqual([]);
  });

  it('registering the same PR twice records it once', async () => {
    await register(1); await register(1);
    expect(registry).toHaveLength(1);
  });

  it('a stale worker row does not resurrect a PR the registry knows is merged', async () => {
    await register(1); await register(2);
    await merge(2); // worker row still says PR 2 is open
    expect(await otherOpenPrsOfTask('t1', { prUrl: url(1) })).toEqual([]);
  });

  it('the last open PR closed unmerged settles a task whose others merged', async () => {
    await register(1); await register(2);
    await merge(1);
    await markTaskPrState(url(2), 'closed');
    expect(await lastPrSettledWithMerge('t1', { prUrl: url(2) })).toBe(true);
  });

  it('closing every PR unmerged does not settle the task as delivered', async () => {
    await register(1); await register(2);
    await markTaskPrState(url(1), 'closed');
    await markTaskPrState(url(2), 'closed');
    expect(await lastPrSettledWithMerge('t1', { prUrl: url(2) })).toBe(false);
  });

  it('a reopened PR blocks again', async () => {
    await register(1); await register(2);
    await markTaskPrState(url(2), 'closed');
    await markTaskPrState(url(2), 'open');
    expect(await otherOpenPrsOfTask('t1', { prUrl: url(1) })).toEqual([url(2)]);
  });
});
