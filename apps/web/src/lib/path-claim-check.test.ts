/**
 * The shared check_path_claim implementation. Both entry points (MCP tool,
 * POST /api/tasks/[id]/path-claim) delegate here; their own tests assert the
 * delegation, this file asserts the behaviour once.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const TASK_ID = '11111111-1111-1111-1111-111111111111';
const SIBLING_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MISSION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OTHER_MISSION_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockInsertValues = mock(() => Promise.resolve([]));
const mockInsert = mock(() => ({ values: mockInsertValues }));
mock.module('@buildd/core/db', () => ({
  db: { query: { tasks: { findFirst: mockTasksFindFirst } }, insert: mockInsert },
}));

const acquired = (over: Record<string, unknown> = {}) =>
  ({ kind: 'acquired', inserted: [], blocked: [], pathManifest: null, revision: 1, ...over }) as any;
const conflictResult = (blockingTaskId: string, blockingPath: string) =>
  ({ kind: 'conflict', conflict: { blockingTaskId, blockingPath }, blocked: [] }) as any;
const mockAcquirePathClaims = mock(async (_input: any) => acquired());
const mockNarrowPathClaims = mock(async (_input: any) => ({ kind: 'not_found' }) as any);
const mockRegisterWaiter = mock(async () => ({ registered: true }) as any);
mock.module('@buildd/core/path-claim', () => ({
  acquirePathClaims: mockAcquirePathClaims,
  narrowPathClaims: mockNarrowPathClaims,
  registerWaiter: mockRegisterWaiter,
}));

const mockDeliverPathReleased = mock(async (..._args: any[]) => {});
mock.module('@/lib/path-claim-release', () => ({
  deliverPathReleased: mockDeliverPathReleased,
}));

const { GATE_SLUGS: REAL_GATE_SLUGS } = await import('@buildd/core/gate-slugs');
const mockFireGateEvent = mock((_input: any) => 'sig');
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: REAL_GATE_SLUGS,
  fireGateEvent: mockFireGateEvent,
  gateCallerOrigin: () => 'worker',
}));

import { checkPathClaim, narrowPathClaim } from './path-claim-check';

function task(overrides: Record<string, unknown> = {}) {
  return { id: TASK_ID, workspaceId: WORKSPACE_ID, missionId: null, status: 'in_progress', pathManifest: null, ...overrides };
}

const base = { taskId: TASK_ID, surface: 'test-surface', callerOrigin: 'worker' as const };

describe('checkPathClaim', () => {
  beforeEach(() => {
    for (const m of [mockTasksFindFirst, mockInsert, mockInsertValues, mockAcquirePathClaims, mockNarrowPathClaims, mockDeliverPathReleased, mockRegisterWaiter, mockFireGateEvent]) m.mockReset();
    mockTasksFindFirst.mockResolvedValue(task());
    mockAcquirePathClaims.mockImplementation(async (input: any) => acquired({ inserted: input.paths, pathManifest: input.paths }));
    mockRegisterWaiter.mockResolvedValue({ registered: true });
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockResolvedValue([]);
  });

  it('rejects non-string / blank / empty paths before loading the task', async () => {
    for (const paths of [undefined, [], [''], ['  '], [1]]) {
      const r = await checkPathClaim({ ...base, paths });
      expect(r.kind).toBe('invalid_paths');
    }
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
  });

  it('rejects a wildcard and records a rejected gate event', async () => {
    const r = await checkPathClaim({ ...base, paths: ['src/a.ts', '**'] });
    expect(r.kind).toBe('wildcard');
    // The path_declaration denominator row (conflict-aware-orchestration §3) fires too.
    const pathClaimEvents = mockFireGateEvent.mock.calls.map((c: any) => c[0]).filter((e: any) => e.gate === REAL_GATE_SLUGS.PATH_CLAIM);
    expect(pathClaimEvents).toHaveLength(1);
    const ev: any = pathClaimEvents[0];
    expect(ev.gate).toBe(REAL_GATE_SLUGS.PATH_CLAIM);
    expect(ev.outcome).toBe('rejected');
    expect(ev.surface).toBe('test-surface');
    expect(ev.taskId).toBe(TASK_ID);
    expect(mockAcquirePathClaims).not.toHaveBeenCalled();
  });

  it('returns not_found when the task is missing or authorize refuses', async () => {
    mockTasksFindFirst.mockResolvedValueOnce(null);
    expect((await checkPathClaim({ ...base, paths: ['a.ts'] })).kind).toBe('not_found');
    const r = await checkPathClaim({ ...base, paths: ['a.ts'], authorize: async () => false });
    expect(r.kind).toBe('not_found');
    expect(mockAcquirePathClaims).not.toHaveBeenCalled();
  });

  it('refuses a terminal task', async () => {
    mockTasksFindFirst.mockResolvedValue(task({ status: 'completed' }));
    const r = await checkPathClaim({ ...base, paths: ['a.ts'] });
    expect(r.kind).toBe('bad_status');
  });

  it('acquires through the one locked primitive, as a declaration', async () => {
    mockTasksFindFirst.mockResolvedValue(task({ pathManifest: ['old.ts'] }));
    mockAcquirePathClaims.mockResolvedValue(acquired({ inserted: ['old.ts', 'new.ts'], pathManifest: ['old.ts', 'new.ts'], revision: 4 }));
    const r = await checkPathClaim({ ...base, paths: ['old.ts', 'new.ts'] });
    expect(r).toEqual({ kind: 'claimed', pathManifest: ['old.ts', 'new.ts'], revision: 4 });
    expect(mockAcquirePathClaims).toHaveBeenCalledTimes(1);
    expect(mockAcquirePathClaims).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, taskId: TASK_ID, paths: ['old.ts', 'new.ts'], declare: true });
    expect(mockFireGateEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'accepted', detail: { claimResult: 'claimed', pathCount: 2, leased: 2 } }));
  });

  // Regression: a path already in the manifest used to return claimed:true
  // before any lease was inserted, so the claim-route backstop never saw it.
  it('still acquires a lease when every path is already in the manifest', async () => {
    mockTasksFindFirst.mockResolvedValue(task({ pathManifest: ['a.ts'] }));
    mockAcquirePathClaims.mockResolvedValue(acquired({ inserted: ['a.ts'], pathManifest: ['a.ts'] }));
    const r = await checkPathClaim({ ...base, paths: ['a.ts'] });
    expect(r).toMatchObject({ kind: 'claimed', pathManifest: ['a.ts'] });
    expect(mockAcquirePathClaims).toHaveBeenCalledTimes(1);
    expect(mockFireGateEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'accepted', detail: { claimResult: 'claimed', pathCount: 1, leased: 1 } }));
  });

  it('reports bad_status when the task closed between its read and the locked write', async () => {
    mockAcquirePathClaims.mockResolvedValue({ kind: 'task_closed' } as any);
    const r = await checkPathClaim({ ...base, paths: ['a.ts'] });
    expect(r.kind).toBe('bad_status');
    expect(mockFireGateEvent).not.toHaveBeenCalled();
  });

  it('on conflict: registers a waiter, points at the path_released message, records a deferred gate event', async () => {
    mockAcquirePathClaims.mockResolvedValue(conflictResult(SIBLING_ID, 'shared.ts'));
    mockTasksFindFirst
      .mockResolvedValueOnce(task({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Sibling', missionId: OTHER_MISSION_ID });

    const r = await checkPathClaim({ ...base, paths: ['shared.ts'] });
    expect(r.kind).toBe('conflict');
    if (r.kind !== 'conflict') throw new Error('unreachable');
    expect(r.body.claimed).toBe(false);
    expect(r.body.blockingTaskId).toBe(SIBLING_ID);
    expect(r.body.blockingMissionId).toBe(OTHER_MISSION_ID);
    expect(r.body.message).toContain('different mission');
    expect(r.body.message).toContain('path_released message');
    expect(r.body.message).toContain('next turn boundary');
    expect(r.body.message).not.toContain('Pusher');
    expect(mockRegisterWaiter).toHaveBeenCalledWith(SIBLING_ID, TASK_ID, 'shared.ts', WORKSPACE_ID);

    // The path_declaration denominator row (conflict-aware-orchestration §3) fires too.
    const pathClaimEvents = mockFireGateEvent.mock.calls.map((c: any) => c[0]).filter((e: any) => e.gate === REAL_GATE_SLUGS.PATH_CLAIM);
    expect(pathClaimEvents).toHaveLength(1);
    const ev: any = pathClaimEvents[0];
    expect(ev.outcome).toBe('deferred');
    expect(ev.gate).toBe(REAL_GATE_SLUGS.PATH_CLAIM);
    expect(ev.detail).toEqual({ blockingTaskId: SIBLING_ID, blockingPath: 'shared.ts', crossMission: true, deadlock: false });
  });

  it('on conflict: the body names the held path and every requested path that is held, so a runner can deny per path', async () => {
    mockAcquirePathClaims.mockResolvedValue({
      kind: 'conflict',
      conflict: { blockingTaskId: SIBLING_ID, blockingPath: 'apps/web' },
      blocked: [
        { path: 'apps/web/a.ts', blockingTaskId: SIBLING_ID, blockingPath: 'apps/web' },
        { path: 'apps/web/b.ts', blockingTaskId: SIBLING_ID, blockingPath: 'apps/web' },
      ],
    } as any);
    mockTasksFindFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Sibling', missionId: null });

    const r = await checkPathClaim({ ...base, paths: ['apps/web/a.ts', 'apps/web/b.ts', 'free.ts'] });
    if (r.kind !== 'conflict') throw new Error('expected conflict');
    expect(r.body.blockingPath).toBe('apps/web');
    expect(r.body.blockedPaths).toEqual([
      { path: 'apps/web/a.ts', blockingTaskId: SIBLING_ID, blockingPath: 'apps/web' },
      { path: 'apps/web/b.ts', blockingTaskId: SIBLING_ID, blockingPath: 'apps/web' },
    ]);
  });

  it('on deadlock: flags it, posts a mission note, and the gate event says so', async () => {
    const cycle = [TASK_ID, SIBLING_ID, TASK_ID];
    mockAcquirePathClaims.mockResolvedValue(conflictResult(SIBLING_ID, 'x.ts'));
    mockRegisterWaiter.mockResolvedValue({ deadlock: true, cycle });
    mockTasksFindFirst
      .mockResolvedValueOnce(task({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'B', missionId: MISSION_ID });

    const r = await checkPathClaim({ ...base, paths: ['x.ts'] });
    if (r.kind !== 'conflict') throw new Error(`expected conflict, got ${r.kind}`);
    expect(r.body.deadlock).toBe(true);
    expect(r.body.cycle).toEqual(cycle);
    expect(r.body.message).toContain('DEADLOCK DETECTED');
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockFireGateEvent.mock.calls[0][0].detail.deadlock).toBe(true);
  });
});

describe('narrowPathClaim', () => {
  const narrowed = (over: Record<string, unknown> = {}) => ({
    kind: 'narrowed', workspaceId: WORKSPACE_ID, pathManifest: ['keep.ts'], revision: 5,
    releasedPaths: ['drop.ts'], notifiedWaiters: [SIBLING_ID],
    waiters: [{ waitingTaskId: SIBLING_ID, blockedPath: 'drop.ts' }], ...over,
  }) as any;

  beforeEach(() => {
    for (const m of [mockTasksFindFirst, mockNarrowPathClaims, mockDeliverPathReleased, mockFireGateEvent]) m.mockReset();
    mockTasksFindFirst.mockResolvedValue(task());
    mockNarrowPathClaims.mockResolvedValue(narrowed());
  });

  it('rejects invalid paths, a wildcard and a malformed revision before loading the task', async () => {
    expect((await narrowPathClaim({ ...base, paths: [] })).kind).toBe('invalid_paths');
    expect((await narrowPathClaim({ ...base, paths: ['**'] })).kind).toBe('wildcard');
    expect((await narrowPathClaim({ ...base, paths: ['a.ts'], expectedRevision: -1 })).kind).toBe('invalid_paths');
    expect((await narrowPathClaim({ ...base, paths: ['a.ts'], expectedRevision: '3' })).kind).toBe('invalid_paths');
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
  });

  it('is not_found when authorize refuses — scoped to what the caller can see', async () => {
    const r = await narrowPathClaim({ ...base, paths: ['a.ts'], authorize: async () => false });
    expect(r.kind).toBe('not_found');
    expect(mockNarrowPathClaims).not.toHaveBeenCalled();
  });

  it("narrows in the task's own workspace, delivers only to freed waiters, and records the event", async () => {
    const r = await narrowPathClaim({ ...base, paths: ['drop.ts'], reason: '  stale retry scope ', expectedRevision: 4 });

    expect(mockNarrowPathClaims).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID, taskId: TASK_ID, paths: ['drop.ts'],
      surface: 'test-surface', reason: 'stale retry scope', expectedRevision: 4,
    });
    expect(mockDeliverPathReleased).toHaveBeenCalledTimes(1);
    expect(mockDeliverPathReleased.mock.calls[0][0]).toBe(TASK_ID);
    expect(mockDeliverPathReleased.mock.calls[0][2]).toBe('narrowed');
    expect(r).toEqual({ kind: 'narrowed', pathManifest: ['keep.ts'], releasedPaths: ['drop.ts'], notifiedWaiters: [SIBLING_ID], revision: 5 });
    expect(mockFireGateEvent).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'accepted', detail: { claimResult: 'narrowed', pathCount: 1, released: 1, wokenWaiters: 1 },
    }));
  });

  it('passes a revision conflict through without delivering anything', async () => {
    mockNarrowPathClaims.mockResolvedValue({ kind: 'revision_conflict', currentRevision: 9 });
    const r = await narrowPathClaim({ ...base, paths: ['drop.ts'], expectedRevision: 4 });
    expect(r).toEqual({ kind: 'revision_conflict', currentRevision: 9 });
    expect(mockDeliverPathReleased).not.toHaveBeenCalled();
  });

  it('narrows a terminal task too — giving ownership back is always allowed', async () => {
    mockTasksFindFirst.mockResolvedValue(task({ status: 'completed' }));
    expect((await narrowPathClaim({ ...base, paths: ['drop.ts'] })).kind).toBe('narrowed');
  });
});
