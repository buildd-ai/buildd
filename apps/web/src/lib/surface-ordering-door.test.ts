import { describe, expect, it, mock } from 'bun:test';

let guardCalls = 0;
mock.module('@/lib/surface-ordering', () => ({
  guardSurfaceOrdering: async () => { guardCalls++; return { blocks: false, slot: null }; },
  withMergeSlot: async (_req: unknown, merge: () => Promise<unknown>) => ({ result: await merge() }),
}));
let wsReads = 0;
mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findFirst: async () => { wsReads++; return { gitConfig: null }; } } } },
}));

const { checkSurfaceOrder, mergeInSurfaceSlot } = await import('./surface-ordering-door');

const base = {
  workspaceId: 'ws-1', installationId: 1, repoFullName: 'acme/repo', prNumber: 1, headSha: 'h',
  taskId: null, workerId: null, door: 'auto-merge', callerOrigin: 'system' as const,
};

describe('checkSurfaceOrder', () => {
  it('default policy: passes without running the guard', async () => {
    guardCalls = 0;
    expect(await checkSurfaceOrder({ ...base, gitConfig: null })).toEqual({ blocks: false, slot: null });
    expect(await checkSurfaceOrder({ ...base, gitConfig: { surfaceOrdering: 'off' } as any })).toEqual({ blocks: false, slot: null });
    expect(guardCalls).toBe(0);
  });

  it('opted in: runs the guard', async () => {
    guardCalls = 0;
    await checkSurfaceOrder({ ...base, gitConfig: { surfaceOrdering: 'enforce' } as any });
    expect(guardCalls).toBe(1);
  });

  it('no gitConfig passed: loads it once, and an absent config is off', async () => {
    wsReads = 0; guardCalls = 0;
    await checkSurfaceOrder({ ...base, gitConfig: undefined });
    expect(wsReads).toBe(1);
    expect(guardCalls).toBe(0);
  });
});

describe('mergeInSurfaceSlot', () => {
  it('a blocking verdict never merges', async () => {
    let merged = 0;
    const r = await mergeInSurfaceSlot({ blocks: true, kind: 'ordering', reason: 'wait', counterpartPrNumber: 2, surface: 's' }, async () => { merged++; });
    expect(r).toEqual({ refused: 'wait' });
    expect(merged).toBe(0);
  });

  it('no slot: just merges', async () => {
    const r = await mergeInSurfaceSlot({ blocks: false, slot: null }, async () => 'ok');
    expect(r).toEqual({ result: 'ok' });
  });
});
