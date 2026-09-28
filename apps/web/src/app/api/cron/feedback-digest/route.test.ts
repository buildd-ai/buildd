/**
 * The feedback-digest cron also carries the memory index reconcile pass, so the
 * catch-up needs no schedule (and no Neon wake window) of its own. It runs even
 * when the digest itself fails, and its failures show up in the run report.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

let digestThrows = false;
let reconcileResult: { scanned: number; mirrored: number; failed: number } = { scanned: 0, mirrored: 0, failed: 0 };
const reconcileCalls: unknown[] = [];
let lastReport: any = null;

mock.module('@/lib/feedback-digest', () => ({
  runFeedbackDigest: async () => {
    if (digestThrows) throw new Error('digest down');
    return { results: [], totalFeedback: 0 };
  },
  getFeedbackStats: async () => ({ total: 0, bySignal: {}, byEntityType: {} }),
}));
mock.module('@/lib/cron-run', () => ({
  withCronRun: async (_job: string, _req: NextRequest, handler: (r: (o: unknown) => void) => Promise<NextResponse>) =>
    handler(o => { lastReport = o; }),
}));
const index = { upsert: async () => ({ inserted: 1, updated: 0, superseded: 0 }) };
mock.module('@/lib/memory-helper', () => ({
  getMemoryIndexStore: () => index,
  getMemoryStoreForTeam: async () => null,
}));
mock.module('@buildd/core/memory-index-reconcile', () => ({
  reconcileMemoryIndex: async (opts: unknown) => {
    reconcileCalls.push(opts);
    return reconcileResult;
  },
  MEMORY_RECONCILE_MAX_ROWS: 25,
  MEMORY_RECONCILE_BUDGET_MS: 15_000,
}));

let lifecycleResult: any = { extracted: { failedTasks: 0, reviews: 0, duplicates: 0, failed: 0 }, promoted: 0, held: 0, shadowed: 0, expired: 0, reverifyFlagged: 0, errors: 0 };
const lifecycleCalls: any[] = [];
mock.module('@buildd/core/memory-lifecycle', () => ({
  runMemoryLifecycle: async (opts: unknown) => {
    lifecycleCalls.push(opts);
    return lifecycleResult;
  },
  // The real budget helpers (pure), so the wiring is tested against them.
  cronStepBudgetMs: (cap: number, elapsed: number, max: number) => Math.max(0, Math.min(cap, max - 5_000 - Math.max(0, elapsed))),
  lifecycleDeadlineMs: (elapsed: number, max: number) => Math.max(0, Math.min(20_000, max - 5_000 - Math.max(0, elapsed))),
}));
const decider = { judgeLearn: async () => ({}) };
mock.module('@/lib/memory-decisions', () => ({ memoryDeciderFor: () => decider }));

const { POST } = await import('./route');

const call = () => POST(new NextRequest('http://localhost/api/cron/feedback-digest', { method: 'POST' }));

beforeEach(() => {
  digestThrows = false;
  reconcileResult = { scanned: 0, mirrored: 0, failed: 0 };
  reconcileCalls.length = 0;
  lifecycleCalls.length = 0;
  lifecycleResult = { extracted: { failedTasks: 0, reviews: 0, duplicates: 0, failed: 0 }, promoted: 0, held: 0, shadowed: 0, expired: 0, reverifyFlagged: 0, errors: 0 };
  lastReport = null;
});

describe('feedback-digest cron: memory index reconcile', () => {
  it('runs the reconcile pass against the memory index and reports it', async () => {
    reconcileResult = { scanned: 3, mirrored: 3, failed: 0 };
    const res = await call();
    const body = await res.json();
    expect(reconcileCalls).toHaveLength(1);
    expect((reconcileCalls[0] as any).knowledgeStore).toBe(index);
    expect(body.memoryIndexReconcile).toEqual(reconcileResult);
    expect(lastReport.result.memoryIndexReconcile).toEqual(reconcileResult);
    expect(lastReport.errors).toBeUndefined();
  });

  it('counts rows that still failed to mirror as run errors', async () => {
    reconcileResult = { scanned: 2, mirrored: 1, failed: 1 };
    await call();
    expect(lastReport.errors).toBe(1);
  });

  it('still reconciles when the digest fails', async () => {
    digestThrows = true;
    const err = console.error;
    console.error = () => {};
    const res = await call();
    console.error = err;
    expect(res.status).toBe(500);
    expect(reconcileCalls).toHaveLength(1);
    expect(lastReport.result.memoryIndexReconcile).toEqual(reconcileResult);
  });
});

describe('feedback-digest cron: memory lifecycle', () => {
  it('runs the lifecycle pass with the memory index and the decider, and reports it', async () => {
    lifecycleResult = { ...lifecycleResult, promoted: 2, expired: 1 };
    const body = await (await call()).json();
    expect(lifecycleCalls).toHaveLength(1);
    expect(lifecycleCalls[0].knowledgeStore).toBe(index);
    expect(lifecycleCalls[0].decider).toBe(decider);
    expect(body.memoryLifecycle).toEqual(lifecycleResult);
    expect(lastReport.result.memoryLifecycle).toEqual(lifecycleResult);
    expect(lastReport.errors).toBeUndefined();
  });

  it('bounds both passes: reconcile by its time budget, the lifecycle by what the cron has left', async () => {
    reconcileCalls.length = 0;
    lifecycleCalls.length = 0;
    await call();
    const r = reconcileCalls.at(-1) as { budgetMs: number };
    const l = lifecycleCalls.at(-1) as { deadlineMs: number };
    expect(r.budgetMs).toBeGreaterThan(0);
    expect(r.budgetMs).toBeLessThanOrEqual(15_000);
    expect(l.deadlineMs).toBeGreaterThan(0);
    expect(l.deadlineMs).toBeLessThanOrEqual(20_000);
  });

  it('counts failed lifecycle steps as run errors', async () => {
    lifecycleResult = { ...lifecycleResult, errors: 2 };
    await call();
    expect(lastReport.errors).toBe(2);
  });

  it('still runs when the digest fails', async () => {
    digestThrows = true;
    const err = console.error;
    console.error = () => {};
    await call();
    console.error = err;
    expect(lifecycleCalls).toHaveLength(1);
    expect(lastReport.result.memoryLifecycle).toEqual(lifecycleResult);
  });
});
