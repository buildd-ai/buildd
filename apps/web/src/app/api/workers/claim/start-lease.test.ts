import { describe, it, expect } from 'bun:test';
import { acquireStartPaths, releaseStartPaths } from './start-lease';

/** Lane paths leased at claim (./start-lease). Every dependency is injected: no DB. */

const WS = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const HOLDER = '00000000-0000-4000-8000-000000000002';

describe('start lease', () => {
  it('acquires the declared paths through the exclusive primitive, all-or-nothing', async () => {
    const calls: any[] = [];
    const ok = await acquireStartPaths({ workspaceId: WS, taskId: TASK, paths: ['**', 'apps/web/src/widget.ts'] }, {
      acquire: async (input) => { calls.push(input); return { kind: 'acquired', inserted: ['apps/web/src/widget.ts'], insertedIds: ['lease-1'], blocked: [], pathManifest: null, revision: 1 }; },
    });
    expect(ok).toEqual({ ok: true, inserted: ['apps/web/src/widget.ts'], insertedIds: ['lease-1'] });
    expect(calls).toEqual([{ workspaceId: WS, taskId: TASK, paths: ['apps/web/src/widget.ts'], declare: true }]);
  });

  it('a conflict, a closed task or an error holds', async () => {
    const input = { workspaceId: WS, taskId: TASK, paths: ['a.ts'] };
    expect((await acquireStartPaths(input, { acquire: async () => ({ kind: 'conflict', conflict: {} as any, blocked: [] }) })).ok).toBe(false);
    expect((await acquireStartPaths(input, { acquire: async () => ({ kind: 'task_closed' }) })).ok).toBe(false);
    expect((await acquireStartPaths(input, { acquire: async () => { throw new Error('x'); } })).ok).toBe(false);
  });

  it('the repo-wide sentinel acquires nothing up front (observed touches lease later)', async () => {
    let called = false;
    expect(await acquireStartPaths({ workspaceId: WS, taskId: TASK, paths: ['**'] }, { acquire: async () => { called = true; return { kind: 'task_closed' }; } })).toEqual({ ok: true, inserted: [], insertedIds: [] });
    expect(called).toBe(false);
  });

  describe('releaseStartPaths: a claim that lost the atomic race gives its new leases back', () => {
    const input = { workspaceId: WS, taskId: TASK, insertedIds: ['lease-1'] };
    const released = (paths: string[], waiters: Array<{ waitingTaskId: string; blockedPath: string }> = []) => async () => ({
      kind: 'released' as const,
      result: { workspaceId: WS, releasedPaths: paths, notifiedWaiters: waiters.map(w => w.waitingTaskId), waiters },
    });

    it('releases only the rows this attempt inserted, never the task\'s other leases', async () => {
      const calls: any[] = [];
      const out = await releaseStartPaths(input, {
        releaseRows: async (a) => { calls.push(a); return released(['apps/web/src/widget.ts'])(); },
        releaseReason: async () => 'abandoned',
        deliver: async () => {},
      });
      expect(out).toBe('released');
      expect(calls).toEqual([{ workspaceId: WS, taskId: TASK, leaseIds: ['lease-1'], keepStatuses: ['assigned', 'in_progress', 'review'] }]);
    });

    it('keeps them when the winning claim now owns the task (decided under the lock)', async () => {
      let delivered = 0;
      const out = await releaseStartPaths(input, { releaseRows: async () => ({ kind: 'kept' }), deliver: async () => { delivered++; } });
      expect(out).toBe('kept_live_owner');
      expect(delivered).toBe(0);
    });

    it('waiters hear the task\'s real release reason, not a blanket "abandoned"', async () => {
      const seen: any[] = [];
      const out = await releaseStartPaths(input, {
        releaseRows: released(['apps/web/src/widget.ts'], [{ waitingTaskId: HOLDER, blockedPath: 'apps/web/src/widget.ts' }]),
        releaseReason: async (taskId) => { expect(taskId).toBe(TASK); return 'merged'; },
        deliver: async (taskId, result, reason) => { seen.push({ taskId, reason, waiters: result.notifiedWaiters }); },
      });
      expect(out).toBe('released');
      expect(seen).toEqual([{ taskId: TASK, reason: 'merged', waiters: [HOLDER] }]);
    });

    it('nothing inserted: nothing to release, no statement', async () => {
      let calls = 0;
      const out = await releaseStartPaths({ ...input, insertedIds: [] }, { releaseRows: async () => { calls++; return { kind: 'nothing' }; } });
      expect(out).toBe('nothing_inserted');
      expect(calls).toBe(0);
    });

    it('never throws: a failed release is reported, the reaper is the backstop', async () => {
      expect(await releaseStartPaths(input, { releaseRows: async () => { throw new Error('db'); } })).toBe('error');
    });
  });
});
