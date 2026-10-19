import { describe, expect, it } from 'bun:test';
import {
  isRecoverableBlockerRepair,
  reconcileBlockedOnRepair,
  repairFailureContext,
  type ParkedOnRepair,
  type ReconcilePort,
} from './recoverable-blocker-reconcile';

function fakePort(parked: ParkedOnRepair[]) {
  const calls = { noted: [] as Array<{ taskIds: string[]; summary: string }>, superseded: [] as Array<[string, string[]]>, requeued: [] as string[][] };
  // Mirrors the real writers: a superseded worker leaves waiting_input, a requeue flips only failed tasks.
  const live = [...parked];
  const failed = new Set<string>();
  const port: ReconcilePort = {
    async parkedOn() { return [...live]; },
    async noteRepair(taskIds, ctx) { calls.noted.push({ taskIds, summary: ctx.summary }); },
    async supersede(accountId, workerIds) {
      calls.superseded.push([accountId, workerIds]);
      for (const id of workerIds) {
        const i = live.findIndex(p => p.workerId === id);
        if (i >= 0) { if (live[i].taskId) failed.add(live[i].taskId!); live.splice(i, 1); }
      }
      return workerIds.length;
    },
    async requeue(taskIds) {
      calls.requeued.push(taskIds);
      const out = taskIds.filter(t => failed.has(t));
      out.forEach(t => failed.delete(t));
      return out;
    },
  };
  return { port, calls };
}

describe('isRecoverableBlockerRepair', () => {
  it('reads the context type the repair filer writes', () => {
    expect(isRecoverableBlockerRepair({ type: 'recoverable_blocker_repair', blockedTaskIds: ['t'] })).toBe(true);
    expect(isRecoverableBlockerRepair({ type: 'other' })).toBe(false);
    expect(isRecoverableBlockerRepair(null)).toBe(false);
  });
});

describe('reconcileBlockedOnRepair', () => {
  const repair = { id: 'abcd1234-0000-4000-8000-000000000000', summary: 'No code change needed. Already fixed on dev by #5215.' };

  it('a repair that completes while the blocked task is parked waiting_input closes the question and requeues the task', async () => {
    const { port, calls } = fakePort([{ workerId: 'w-blocked', taskId: 't-blocked', accountId: 'a1' }]);
    const out = await reconcileBlockedOnRepair(port, repair);
    expect(out).toEqual({ closed: 1, requeued: ['t-blocked'] });
    expect(calls.superseded).toEqual([['a1', ['w-blocked']]]);
    // The retry is told what the repair found, before it is requeued.
    expect(calls.noted[0].taskIds).toEqual(['t-blocked']);
    expect(calls.noted[0].summary).toContain('#5215');
    expect(calls.noted[0].summary).toContain('alreadyShippedIn');
  });

  it('is idempotent: a second run (a duplicate completion PATCH) closes and requeues nothing', async () => {
    const { port, calls } = fakePort([{ workerId: 'w-blocked', taskId: 't-blocked', accountId: 'a1' }]);
    await reconcileBlockedOnRepair(port, repair);
    const again = await reconcileBlockedOnRepair(port, repair);
    expect(again).toEqual({ closed: 0, requeued: [] });
    expect(calls.requeued).toHaveLength(1);
  });

  it('nothing parked on the repair: no writes', async () => {
    const { port, calls } = fakePort([]);
    expect(await reconcileBlockedOnRepair(port, repair)).toEqual({ closed: 0, requeued: [] });
    expect(calls.noted).toHaveLength(0);
    expect(calls.superseded).toHaveLength(0);
  });

  it('groups closes by account and requeues each blocked task once', async () => {
    const { port, calls } = fakePort([
      { workerId: 'w1', taskId: 't1', accountId: 'a1' },
      { workerId: 'w2', taskId: 't2', accountId: 'a2' },
      { workerId: 'w3', taskId: 't1', accountId: 'a1' },
    ]);
    const out = await reconcileBlockedOnRepair(port, repair);
    expect(calls.superseded).toEqual([['a1', ['w1', 'w3']], ['a2', ['w2']]]);
    expect(calls.requeued).toEqual([['t1', 't2']]);
    expect(out.requeued.sort()).toEqual(['t1', 't2']);
  });
});

describe('repairFailureContext', () => {
  it('names the repair by short id and never asks for a new PR when work already shipped', () => {
    const ctx = repairFailureContext({ id: 'abcd1234-0000-4000-8000-000000000000', summary: null });
    expect(ctx.summary).toContain('abcd1234');
    expect(ctx.summary).not.toContain('abcd1234-0000');
    expect(ctx.errorType).toBe('recoverable_blocker_repaired');
  });
});
