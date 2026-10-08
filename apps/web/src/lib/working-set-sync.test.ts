/**
 * PATCH-side glue for the authoritative working set (path-claim-ownership.md):
 * delta parsing bounds, the bounded observed SAMPLE and its once-per-worker
 * advisory, the ledger rows a ship checkpoint leaves, and the PR handoff.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/working-set-sync.test.ts
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const reconcileCalls: any[] = [];
let reconcileResult: any;
let reconcileThrows = false;
const mockReconcile = mock(async (input: any) => {
  reconcileCalls.push(input);
  if (reconcileThrows) throw new Error('db down');
  return reconcileResult;
});
const mockRecordWorkingSet = mock(async () => {});
const mockPromote = mock(async (_input: any) => ({ promoted: 2, replacedSentinel: true, at: 'x', workerId: 'w1', prNumber: 7 }));
const mockActiveLeasePaths = mock(async () => ['a.ts']);
mock.module('@buildd/core/path-claim', () => ({
  reconcileWorkingSet: mockReconcile,
  recordWorkingSet: mockRecordWorkingSet,
  workingSetRecord: (input: any) => ({ generation: input.ack.generation, coverage: input.ack.coverage, heldCount: input.ack.heldCount, blockedCount: input.ack.blocked.length, blockedSample: [], checkpoint: input.checkpoint ?? null, workerId: input.workerId, at: 'now' }),
  promoteLeasesToPrScope: mockPromote,
  activeLeasePaths: mockActiveLeasePaths,
}));
const mockDeliver = mock(async () => {});
mock.module('@/lib/path-claim-release', () => ({ deliverPathReleased: mockDeliver }));
const declarations: any[] = [];
mock.module('@/lib/path-declaration-ledger', () => ({ recordPathDeclaration: (i: any) => declarations.push(i) }));
const gateEvents: any[] = [];
const repeatEvents: any[] = [];
mock.module('@/lib/gate-ledger', () => ({
  fireGateEvent: (i: any) => { gateEvents.push(i); return 'sig'; },
  fireRepeatGateEvent: (i: any, opts: any) => { repeatEvents.push({ ...i, opts }); return 'sig'; },
  GATE_SLUGS: { PATH_CLAIM: 'path_claim', PATH_DECLARATION: 'path_declaration' },
}));
mock.module('@buildd/core/db', () => ({
  db: { query: { tasks: { findMany: mock(async () => [{ id: 'holder-1', title: 'Holder task' }]) } } },
}));

import {
  parseWorkingSetDelta,
  parseShipCheckpointReports,
  boundedObservedSample,
  applyWorkingSetSync,
  fireObservationTruncated,
  recordShipCheckpointReports,
  handoffPrScope,
  OBSERVED_TOUCHES_CAP,
} from './working-set-sync';

const worker = { id: 'w1', workspaceId: 'ws-1', taskId: 'task-1' };

beforeEach(() => {
  reconcileCalls.length = 0; declarations.length = 0; gateEvents.length = 0; repeatEvents.length = 0;
  reconcileThrows = false;
  mockRecordWorkingSet.mockClear(); mockDeliver.mockClear(); mockPromote.mockClear();
  reconcileResult = {
    ack: { generation: 1, acquired: ['a.ts'], blocked: [], released: [], heldCount: 1, applied: true, coverage: 'complete' },
    blocked: [], release: null, latencyMs: 12, sizeBucket: '<=50',
  };
});

describe('parseWorkingSetDelta', () => {
  it('accepts a well-formed delta and drops malformed or oversized ones', () => {
    expect(parseWorkingSetDelta({ generation: 3, add: ['a'], remove: [], complete: true, checkpoint: 'pre_push', includeHeld: true }))
      .toEqual({ generation: 3, add: ['a'], remove: [], complete: true, checkpoint: 'pre_push', includeHeld: true });
    expect(parseWorkingSetDelta({ generation: 3 })).toEqual({ generation: 3, add: [], remove: [], complete: false });
    expect(parseWorkingSetDelta(null)).toBeNull();
    expect(parseWorkingSetDelta({ add: ['a'] })).toBeNull();
    expect(parseWorkingSetDelta({ generation: -1, add: [] })).toBeNull();
    expect(parseWorkingSetDelta({ generation: 1, add: 'a' })).toBeNull();
    expect(parseWorkingSetDelta({ generation: 1, add: Array(5000).fill('p') })).toBeNull();
    expect(parseWorkingSetDelta({ generation: 1, checkpoint: 'bogus', add: [] })?.checkpoint).toBeUndefined();
  });

  it('parses ship checkpoint reports and ignores junk', () => {
    expect(parseShipCheckpointReports([
      { source: 'pre_push', result: 'unknown', cause: 'timeout', refused: true, attempts: 3, at: 5 },
      { source: 'nope', result: 'unknown', cause: 'timeout' },
      { source: 'completion', result: 'ok', cause: 'timeout' },
      null,
    ])).toEqual([{ source: 'pre_push', result: 'unknown', cause: 'timeout', refused: true, attempts: 3, at: 5 }]);
  });
});

describe('boundedObservedSample', () => {
  it('stays bounded and reports the crossing once', () => {
    const first = boundedObservedSample(null, Array.from({ length: 600 }, (_, i) => `p${i}`));
    expect(first.sample).toHaveLength(OBSERVED_TOUCHES_CAP);
    expect(first.crossedCap).toBe(true);
    expect(first.dropped).toBe(100);
    // Already at the cap: more paths are not a second crossing.
    const next = boundedObservedSample(first.sample, ['p600', 'p601']);
    expect(next.sample).toHaveLength(OBSERVED_TOUCHES_CAP);
    expect(next.crossedCap).toBe(false);
    expect(next.dropped).toBe(2);
    // Under the cap: dedup-append.
    expect(boundedObservedSample(['a'], ['a', 'b']).sample).toEqual(['a', 'b']);
  });

  it('the advisory is tagged observation_truncated, never degraded enforcement', () => {
    fireObservationTruncated({ id: 'w1', workspaceId: 'ws-1', taskId: 'task-1' }, boundedObservedSample(null, Array(501).fill(0).map((_, i) => `p${i}`)));
    expect(repeatEvents).toHaveLength(1);
    expect(repeatEvents[0].outcome).toBe('warned');
    expect(repeatEvents[0].detail.signal).toBe('observation_truncated');
    expect(repeatEvents[0].reason).not.toMatch(/degraded/);
  });

  it('collapses to one advisory per TASK: every worker (retries, resumes) coalesces onto the task key', () => {
    const sample = boundedObservedSample(null, Array(501).fill(0).map((_, i) => `p${i}`));
    fireObservationTruncated({ id: 'w1', workspaceId: 'ws-1', taskId: 'task-1' }, sample);
    fireObservationTruncated({ id: 'w2', workspaceId: 'ws-1', taskId: 'task-1' }, sample);
    expect(gateEvents).toHaveLength(0);
    expect(repeatEvents.map(e => e.opts.key)).toEqual([{ taskId: 'task-1' }, { taskId: 'task-1' }]);
    // Long enough to outlive any one task: one row, a count, never a row per claim.
    expect(repeatEvents[0].opts.windowMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });
});

describe('applyWorkingSetSync', () => {
  it('applies the delta, records the proof on a completed sync, and tallies the size bucket', async () => {
    const out = await applyWorkingSetSync({ worker, delta: { generation: 1, add: ['a.ts'], remove: [], complete: true }, readOnly: false });
    expect(reconcileCalls[0]).toMatchObject({ workspaceId: 'ws-1', taskId: 'task-1', readOnly: false });
    expect(out.ack.coverage).toBe('complete');
    expect(mockRecordWorkingSet).toHaveBeenCalledTimes(1);
    expect(declarations[0]).toMatchObject({ result: 'succeeded', provenance: 'observed', pathCount: 1, detail: { sizeBucket: '<=50', leased: 1 } });
  });

  it('a partial chunk of a big set does not write the proof each time', async () => {
    reconcileResult.ack.coverage = 'partial';
    await applyWorkingSetSync({ worker, delta: { generation: 1, add: ['a.ts'], remove: [], complete: false }, readOnly: false });
    expect(mockRecordWorkingSet).not.toHaveBeenCalled();
  });

  it('a blocked path names its holder (title resolved) and is tagged claim_blocked', async () => {
    reconcileResult = {
      ack: { generation: 2, acquired: [], blocked: [{ path: 'b.ts', blockingTaskId: 'holder-1', blockingTaskTitle: null, blockingPath: 'b.ts' }], released: [], heldCount: 1, applied: true, coverage: 'blocked' },
      blocked: [{ path: 'b.ts', blockingTaskId: 'holder-1', blockingPath: 'b.ts' }], release: null, latencyMs: 3, sizeBucket: '<=50',
    };
    const out = await applyWorkingSetSync({ worker, delta: { generation: 2, add: ['b.ts'], remove: [], complete: true }, readOnly: false });
    expect(out.collisions).toEqual([{ path: 'b.ts', blockingTaskId: 'holder-1', blockingTaskTitle: 'Holder task', blockingPath: 'b.ts' }]);
    expect(out.ack.blocked[0].blockingTaskTitle).toBe('Holder task');
    expect(declarations[0]).toMatchObject({ result: 'denied', detail: { signal: 'claim_blocked' } });
    expect(mockRecordWorkingSet).toHaveBeenCalledTimes(1);
  });

  it('a removal that woke a waiter delivers path_released as narrowed', async () => {
    reconcileResult.release = { workspaceId: 'ws-1', releasedPaths: ['c.ts'], notifiedWaiters: ['t2'], waiters: [{ waitingTaskId: 't2', blockedPath: 'c.ts' }] };
    await applyWorkingSetSync({ worker, delta: { generation: 3, add: [], remove: ['c.ts'], complete: true }, readOnly: false });
    expect(mockDeliver).toHaveBeenCalledWith('task-1', reconcileResult.release, 'narrowed');
  });

  it('a reconcile failure never fails the PATCH and never claims coverage', async () => {
    reconcileThrows = true;
    const out = await applyWorkingSetSync({ worker, delta: { generation: 4, add: ['a.ts'], remove: [], complete: true }, readOnly: false });
    expect(out.ack).toMatchObject({ applied: false, coverage: 'partial', acquired: [] });
  });
});

describe('ship checkpoint reports', () => {
  it('a refused ship is a deferral tagged coverage_unknown_at_ship; advisory is a warning; repeats coalesce per worker and cause', () => {
    recordShipCheckpointReports({ id: 'w1', workspaceId: 'ws-1', taskId: 'task-1' }, [
      { source: 'pre_push', result: 'unknown', cause: 'timeout', refused: true, attempts: 3, at: 1 },
      { source: 'completion', result: 'unknown', cause: 'error', refused: false, attempts: 2, at: 2 },
    ]);
    expect(repeatEvents).toHaveLength(2);
    expect(repeatEvents[0]).toMatchObject({ outcome: 'deferred', detail: { signal: 'coverage_unknown_at_ship', cause: 'timeout', refused: true } });
    expect(repeatEvents[0].reason).toMatch(/coverage unknown/);
    expect(repeatEvents[0].opts.key).toEqual({ workerId: 'w1', cause: 'timeout', refused: 'true' });
    expect(repeatEvents[1]).toMatchObject({ outcome: 'warned', detail: { refused: false, cause: 'error' } });
  });
});

describe('handoffPrScope', () => {
  it('promotes leases into the open-PR scope and swallows failures', async () => {
    await handoffPrScope({ workspaceId: 'ws-1', taskId: 'task-1', workerId: 'w1', prNumber: 7 });
    expect(mockPromote).toHaveBeenCalledWith({ workspaceId: 'ws-1', taskId: 'task-1', workerId: 'w1', prNumber: 7 });
    mockPromote.mockImplementationOnce(async () => { throw new Error('db'); });
    await expect(handoffPrScope({ workspaceId: 'ws-1', taskId: 'task-1', workerId: 'w1', prNumber: 7 })).resolves.toBeUndefined();
  });
});
