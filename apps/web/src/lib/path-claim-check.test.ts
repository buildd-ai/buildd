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

const mockAppendPathManifest = mock(async (_t: string, paths: string[]) => paths);
const mockCheckPathClaimConflict = mock(async () => null as any);
const mockInsertClaims = mock(async () => [] as string[]);
const mockRegisterWaiter = mock(async () => ({ registered: true }) as any);
mock.module('@buildd/core/path-claim', () => ({
  appendPathManifest: mockAppendPathManifest,
  checkPathClaimConflict: mockCheckPathClaimConflict,
  insertClaims: mockInsertClaims,
  registerWaiter: mockRegisterWaiter,
}));

const { GATE_SLUGS: REAL_GATE_SLUGS } = await import('@buildd/core/gate-slugs');
const mockFireGateEvent = mock((_input: any) => 'sig');
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: REAL_GATE_SLUGS,
  fireGateEvent: mockFireGateEvent,
  gateCallerOrigin: () => 'worker',
}));

import { checkPathClaim } from './path-claim-check';

function task(overrides: Record<string, unknown> = {}) {
  return { id: TASK_ID, workspaceId: WORKSPACE_ID, missionId: null, status: 'in_progress', pathManifest: null, ...overrides };
}

const base = { taskId: TASK_ID, surface: 'test-surface', callerOrigin: 'worker' as const };

describe('checkPathClaim', () => {
  beforeEach(() => {
    for (const m of [mockTasksFindFirst, mockInsert, mockInsertValues, mockAppendPathManifest, mockCheckPathClaimConflict, mockInsertClaims, mockRegisterWaiter, mockFireGateEvent]) m.mockReset();
    mockTasksFindFirst.mockResolvedValue(task());
    mockCheckPathClaimConflict.mockResolvedValue(null);
    mockAppendPathManifest.mockImplementation(async (_t: string, paths: string[]) => paths);
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
    expect(mockFireGateEvent).toHaveBeenCalledTimes(1);
    const ev = mockFireGateEvent.mock.calls[0][0];
    expect(ev.gate).toBe(REAL_GATE_SLUGS.PATH_CLAIM);
    expect(ev.outcome).toBe('rejected');
    expect(ev.surface).toBe('test-surface');
    expect(ev.taskId).toBe(TASK_ID);
    expect(mockCheckPathClaimConflict).not.toHaveBeenCalled();
  });

  it('returns not_found when the task is missing or authorize refuses', async () => {
    mockTasksFindFirst.mockResolvedValueOnce(null);
    expect((await checkPathClaim({ ...base, paths: ['a.ts'] })).kind).toBe('not_found');
    const r = await checkPathClaim({ ...base, paths: ['a.ts'], authorize: async () => false });
    expect(r.kind).toBe('not_found');
    expect(mockCheckPathClaimConflict).not.toHaveBeenCalled();
  });

  it('refuses a terminal task', async () => {
    mockTasksFindFirst.mockResolvedValue(task({ status: 'completed' }));
    const r = await checkPathClaim({ ...base, paths: ['a.ts'] });
    expect(r.kind).toBe('bad_status');
  });

  it('claims only new paths with one atomic append (no CAS retry) and inserts claims', async () => {
    mockTasksFindFirst.mockResolvedValue(task({ pathManifest: ['old.ts'] }));
    mockAppendPathManifest.mockResolvedValue(['old.ts', 'new.ts']);
    const r = await checkPathClaim({ ...base, paths: ['old.ts', 'new.ts'] });
    expect(r).toEqual({ kind: 'claimed', pathManifest: ['old.ts', 'new.ts'] });
    expect(mockAppendPathManifest).toHaveBeenCalledTimes(1);
    expect(mockAppendPathManifest).toHaveBeenCalledWith(TASK_ID, ['new.ts']);
    expect(mockInsertClaims).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, ['new.ts']);
    expect(mockFireGateEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'accepted', detail: { claimResult: 'claimed', pathCount: 2 } }));
  });

  it('is a no-op when every path is already in the manifest', async () => {
    mockTasksFindFirst.mockResolvedValue(task({ pathManifest: ['a.ts'] }));
    const r = await checkPathClaim({ ...base, paths: ['a.ts'] });
    expect(r).toEqual({ kind: 'claimed', pathManifest: ['a.ts'] });
    expect(mockAppendPathManifest).not.toHaveBeenCalled();
    expect(mockInsertClaims).not.toHaveBeenCalled();
    expect(mockFireGateEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'accepted', detail: { claimResult: 'claimed', pathCount: 1 } }));
  });

  it('on conflict: registers a waiter, points at the path_released message, records a deferred gate event', async () => {
    mockCheckPathClaimConflict.mockResolvedValue({ blockingTaskId: SIBLING_ID, blockingPath: 'shared.ts' });
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
    expect(r.body.message).toContain('update_progress');
    expect(r.body.message).not.toContain('Pusher');
    expect(mockRegisterWaiter).toHaveBeenCalledWith(SIBLING_ID, TASK_ID, 'shared.ts', WORKSPACE_ID);

    expect(mockFireGateEvent).toHaveBeenCalledTimes(1);
    const ev = mockFireGateEvent.mock.calls[0][0];
    expect(ev.outcome).toBe('deferred');
    expect(ev.gate).toBe(REAL_GATE_SLUGS.PATH_CLAIM);
    expect(ev.detail).toEqual({ blockingTaskId: SIBLING_ID, blockingPath: 'shared.ts', crossMission: true, deadlock: false });
    expect(mockAppendPathManifest).not.toHaveBeenCalled();
  });

  it('on deadlock: flags it, posts a mission note, and the gate event says so', async () => {
    const cycle = [TASK_ID, SIBLING_ID, TASK_ID];
    mockCheckPathClaimConflict.mockResolvedValue({ blockingTaskId: SIBLING_ID, blockingPath: 'x.ts' });
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
