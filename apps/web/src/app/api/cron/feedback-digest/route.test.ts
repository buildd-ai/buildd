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
}));

const { POST } = await import('./route');

const call = () => POST(new NextRequest('http://localhost/api/cron/feedback-digest', { method: 'POST' }));

beforeEach(() => {
  digestThrows = false;
  reconcileResult = { scanned: 0, mirrored: 0, failed: 0 };
  reconcileCalls.length = 0;
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
