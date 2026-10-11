/**
 * Runner working-set tracker (path-claim-ownership.md): deltas since the last
 * ACK, bounded chunks, restart replay, reverted paths, blocked holders — all
 * pure over a plain state object.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/working-set-tracker.test.ts
 */
import { describe, test, expect } from 'bun:test';
import {
  createWorkingSetState,
  normalizeWorkingSetState,
  observeWorkingSet,
  nextWorkingSetDelta,
  applyWorkingSetAck,
  workingSetCoverage,
  readWorkingSetAck,
  BLOCKED_RETRY_MS,
} from '../../src/working-set';
import type { WorkingSetAck } from '@buildd/shared';

const HOLDER = 'bbbbbbbb-1111-2222-3333-444444444444';
const files = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `src/f${from + i}.ts`);

function okAck(delta: { generation: number; add: string[]; remove: string[]; complete: boolean }, over: Partial<WorkingSetAck> = {}): WorkingSetAck {
  return {
    generation: delta.generation, acquired: delta.add, blocked: [], released: delta.remove,
    heldCount: 0, applied: true, coverage: delta.complete ? 'complete' : 'partial', ...over,
  };
}

/** Drain every delta against a server that grants everything; returns the deltas sent. */
function drain(state: ReturnType<typeof createWorkingSetState>, now = 1000, checkpoint?: 'pre_push') {
  const sent: any[] = [];
  for (let i = 0; i < 50; i++) {
    const d = nextWorkingSetDelta(state, { now, ...(checkpoint ? { checkpoint } : {}) });
    if (!d) break;
    sent.push(d);
    applyWorkingSetAck(state, d, okAck(d, { heldCount: state.acked.length + d.add.length }), now);
    if (d.complete) break;
  }
  return sent;
}

describe('working-set tracker', () => {
  test('2,000 paths go out as bounded chunks, never a cumulative resend, and end fully acknowledged', () => {
    const state = createWorkingSetState();
    expect(observeWorkingSet(state, { paths: files(2000), trustRemovals: true })).toBe(true);
    expect(state.generation).toBe(1);

    const sent = drain(state);
    expect(sent).toHaveLength(4);
    for (const d of sent) expect(d.add.length).toBeLessThanOrEqual(500);
    expect(sent.slice(0, 3).every(d => d.complete === false)).toBe(true);
    expect(sent[3].complete).toBe(true);
    // Only the first delta asks for the server's held list.
    expect(sent[0].includeHeld).toBe(true);
    expect(sent[1].includeHeld).toBeUndefined();
    // Each path was offered exactly once.
    expect(new Set(sent.flatMap(d => d.add)).size).toBe(2000);
    expect(sent.reduce((n, d) => n + d.add.length, 0)).toBe(2000);
    expect(workingSetCoverage(state)).toEqual({ kind: 'complete', generation: 1, heldCount: 2000 });
    expect(state.ackedGeneration).toBe(1);
  });

  test('an unchanged sweep sends nothing: the steady-state tick is free', () => {
    const state = createWorkingSetState();
    observeWorkingSet(state, { paths: ['a.ts', 'b.ts'], trustRemovals: true });
    drain(state);
    expect(observeWorkingSet(state, { paths: ['b.ts', 'a.ts'], trustRemovals: true })).toBe(false);
    expect(nextWorkingSetDelta(state, { now: 2000 })).toBeNull();
    // A checkpoint still sends the (empty) proof.
    const cp = nextWorkingSetDelta(state, { now: 2000, checkpoint: 'pre_push' });
    expect(cp).toMatchObject({ add: [], remove: [], complete: true, checkpoint: 'pre_push' });
  });

  test('the same delta applied twice is idempotent', () => {
    const state = createWorkingSetState();
    observeWorkingSet(state, { paths: ['a.ts'], trustRemovals: true });
    const d = nextWorkingSetDelta(state, { now: 1 })!;
    applyWorkingSetAck(state, d, okAck(d), 1);
    applyWorkingSetAck(state, d, { ...okAck(d), acquired: [] }, 1);
    expect(state.acked).toEqual(['a.ts']);
    expect(workingSetCoverage(state).kind).toBe('complete');
  });

  test('a sibling holding path #1500 leaves coverage blocked, names the holder, and is re-offered only after the retry window', () => {
    const state = createWorkingSetState();
    observeWorkingSet(state, { paths: files(2000), trustRemovals: true });
    let now = 1000;
    for (let i = 0; i < 10; i++) {
      const d = nextWorkingSetDelta(state, { now });
      if (!d) break;
      const blocked = d.add.includes('src/f1500.ts')
        ? [{ path: 'src/f1500.ts', blockingTaskId: HOLDER, blockingTaskTitle: 'Other', blockingPath: 'src/f1500.ts' }]
        : [];
      applyWorkingSetAck(state, d, okAck(d, { blocked, acquired: d.add.filter(p => p !== 'src/f1500.ts'), coverage: blocked.length ? 'blocked' : d.complete ? 'complete' : 'partial' }), now);
      if (d.complete) break;
    }
    const cov = workingSetCoverage(state);
    expect(cov.kind).toBe('blocked');
    if (cov.kind === 'blocked') expect(cov.blocked[0]).toMatchObject({ path: 'src/f1500.ts', blockingTaskId: HOLDER, blockingTaskTitle: 'Other' });
    expect(state.acked).toHaveLength(1999);
    expect(state.ackedGeneration).toBe(0);

    // Next tick inside the window: nothing to send (the holder has not had time to release).
    expect(nextWorkingSetDelta(state, { now: now + 1 })).toBeNull();
    // Past the window: re-offered. A checkpoint re-offers immediately.
    expect(nextWorkingSetDelta(state, { now: now + BLOCKED_RETRY_MS })!.add).toEqual(['src/f1500.ts']);
    expect(nextWorkingSetDelta(state, { now: now + 1, checkpoint: 'completion' })!.add).toEqual(['src/f1500.ts']);

    // The holder released: the re-offer is granted and coverage is complete.
    now += BLOCKED_RETRY_MS;
    const retry = nextWorkingSetDelta(state, { now })!;
    applyWorkingSetAck(state, retry, okAck(retry), now);
    expect(workingSetCoverage(state).kind).toBe('complete');
    expect(state.blocked).toEqual([]);
  });

  test('a reverted path is sent as a removal and leaves the acknowledged set; an incomplete sweep never removes', () => {
    const state = createWorkingSetState();
    observeWorkingSet(state, { paths: ['a.ts', 'b.ts'], trustRemovals: true });
    drain(state);
    expect(state.acked).toEqual(['a.ts', 'b.ts']);

    // git could not see the whole set: b.ts missing is not evidence of a revert.
    expect(observeWorkingSet(state, { paths: ['a.ts'], trustRemovals: false })).toBe(false);
    expect(nextWorkingSetDelta(state, { now: 5 })).toBeNull();

    // A trusted sweep without b.ts is.
    expect(observeWorkingSet(state, { paths: ['a.ts'], trustRemovals: true })).toBe(true);
    const d = nextWorkingSetDelta(state, { now: 5 })!;
    expect(d).toMatchObject({ add: [], remove: ['b.ts'], complete: true, generation: 2 });
    applyWorkingSetAck(state, d, okAck(d), 5);
    expect(state.acked).toEqual(['a.ts']);
    expect(workingSetCoverage(state)).toEqual({ kind: 'complete', generation: 2, heldCount: 1 });
  });

  test('a restart converges from persisted state plus the server held list, without releasing declared leases', () => {
    // Session 1 acknowledged a.ts and b.ts, then the runner died. Persisted state
    // survives; the server also holds a declared directory lease it never saw here.
    const persisted = JSON.parse(JSON.stringify((() => {
      const s = createWorkingSetState();
      observeWorkingSet(s, { paths: ['a.ts', 'b.ts'], trustRemovals: true });
      drain(s);
      return s;
    })()));
    const state = normalizeWorkingSetState({ ...persisted, seeded: false, blocked: undefined });
    expect(state.acked).toEqual(['a.ts', 'b.ts']);

    // The new session sees c.ts too (committed while it was down); b.ts reverted.
    observeWorkingSet(state, { paths: ['a.ts', 'c.ts'], trustRemovals: true });
    const d = nextWorkingSetDelta(state, { now: 1 })!;
    expect(d).toMatchObject({ add: ['c.ts'], remove: ['b.ts'], includeHeld: true, complete: true });
    applyWorkingSetAck(state, d, okAck(d, { heldPaths: ['a.ts', 'c.ts', 'declared/dir'] }), 1);
    expect(state.seeded).toBe(true);
    expect(state.acked).toEqual(['a.ts', 'c.ts']);
    expect(nextWorkingSetDelta(state, { now: 2 })).toBeNull();
    expect(workingSetCoverage(state).kind).toBe('complete');

    // From nothing at all (no persisted state), the server's held list seeds the intersection only.
    const fresh = createWorkingSetState();
    observeWorkingSet(fresh, { paths: ['a.ts'], trustRemovals: true });
    const d2 = nextWorkingSetDelta(fresh, { now: 1 })!;
    applyWorkingSetAck(fresh, d2, okAck(d2, { acquired: [], heldPaths: ['a.ts', 'declared/dir'] }), 1);
    expect(fresh.acked).toEqual(['a.ts']);
    expect(nextWorkingSetDelta(fresh, { now: 2 })).toBeNull();
  });

  test('a closed task acknowledges nothing, so coverage stays pending', () => {
    const state = createWorkingSetState();
    observeWorkingSet(state, { paths: ['a.ts'], trustRemovals: true });
    const d = nextWorkingSetDelta(state, { now: 1 })!;
    applyWorkingSetAck(state, d, okAck(d, { applied: false, acquired: [] }), 1);
    expect(state.acked).toEqual([]);
    expect(workingSetCoverage(state)).toEqual({ kind: 'pending', remaining: 1 });
  });

  test('regenerable files and the sentinel are never part of the set', () => {
    const state = createWorkingSetState();
    observeWorkingSet(state, { paths: ['docs/specs/INDEX.md', '**', 'src/a.ts'], trustRemovals: true });
    expect(state.current).toEqual(['src/a.ts']);
  });

  test('readWorkingSetAck tolerates an older server that does not answer', () => {
    expect(readWorkingSetAck({})).toBeNull();
    expect(readWorkingSetAck(null)).toBeNull();
    expect(readWorkingSetAck({ workingSetAck: { generation: 3, acquired: ['a'], blocked: [{ path: 'b', blockingTaskId: HOLDER }], coverage: 'blocked' } }))
      .toMatchObject({ generation: 3, acquired: ['a'], applied: true, coverage: 'blocked', blocked: [{ path: 'b', blockingTaskId: HOLDER, blockingTaskTitle: null }] });
  });
});
