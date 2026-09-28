import { describe, it, expect, beforeEach, mock } from 'bun:test';

let missionRow: any = null;
const mockFindFirst = mock(() => Promise.resolve(missionRow));

mock.module('@buildd/core/db', () => ({
  db: { query: { missions: { findFirst: mockFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id' },
}));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
}));

import { wakeMission, type MissionWakeReason } from './mission-wake';

const mockRetrigger = mock((_id: string, _reason: MissionWakeReason) =>
  Promise.resolve({ action: 'retriggered' as const }),
);
const mockIsBlocked = mock((_m: any) => Promise.resolve({ blocked: false }) as any);
const deps = { retrigger: mockRetrigger as any, isMissionBlocked: mockIsBlocked as any };

function mission(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    status: 'active',
    orchestrationMode: 'auto',
    isHeld: false,
    dependsOnMissionId: null,
    gateCondition: 'completed',
    dependencyMetAt: null,
    ...overrides,
  };
}

describe('wakeMission', () => {
  beforeEach(() => {
    missionRow = mission();
    mockFindFirst.mockClear();
    mockRetrigger.mockReset();
    mockRetrigger.mockImplementation(() => Promise.resolve({ action: 'retriggered' as const }));
    mockIsBlocked.mockReset();
    mockIsBlocked.mockImplementation(() => Promise.resolve({ blocked: false }));
  });

  const reasons: MissionWakeReason[] = ['dependency_met', 'resumed', 'budget_raised', 'pr_merged', 'owner_note', 'owner_answer'];

  it.each(reasons)('re-plans an active auto mission once on %s', async (reason) => {
    const out = await wakeMission('m1', reason, deps);
    expect(out).toEqual({ woken: true, action: 'retriggered' });
    expect(mockRetrigger).toHaveBeenCalledTimes(1);
    expect(mockRetrigger).toHaveBeenCalledWith('m1', reason);
  });

  it('is a no-op for a manual mission', async () => {
    missionRow = mission({ orchestrationMode: 'manual' });
    expect(await wakeMission('m1', 'owner_note', deps)).toEqual({ woken: false, reason: 'manual' });
    expect(mockRetrigger).not.toHaveBeenCalled();
  });

  it('is a no-op for a held mission', async () => {
    missionRow = mission({ isHeld: true });
    expect(await wakeMission('m1', 'resumed', deps)).toEqual({ woken: false, reason: 'held' });
    expect(mockRetrigger).not.toHaveBeenCalled();
  });

  it('is a no-op for a dependency-blocked mission', async () => {
    missionRow = mission({ dependsOnMissionId: 'm0', gateCondition: 'merged' });
    mockIsBlocked.mockImplementation(() => Promise.resolve({ blocked: true, reason: 'waiting' }));
    expect(await wakeMission('m1', 'owner_note', deps)).toEqual({ woken: false, reason: 'dependency_blocked' });
    expect(mockIsBlocked).toHaveBeenCalledWith({
      id: 'm1', dependsOnMissionId: 'm0', gateCondition: 'merged', dependencyMetAt: null,
    });
    expect(mockRetrigger).not.toHaveBeenCalled();
  });

  it.each(['paused', 'completed', 'archived', 'budget_exhausted'])('is a no-op for a %s mission', async (status) => {
    missionRow = mission({ status });
    expect(await wakeMission('m1', 'resumed', deps)).toEqual({ woken: false, reason: 'not_active' });
    expect(mockRetrigger).not.toHaveBeenCalled();
  });

  it('is a no-op for a missing mission', async () => {
    missionRow = null;
    expect(await wakeMission('m1', 'pr_merged', deps)).toEqual({ woken: false, reason: 'not_found' });
  });

  it('never throws — a failing retrigger is reported, not raised', async () => {
    mockRetrigger.mockImplementation(() => Promise.reject(new Error('boom')));
    expect(await wakeMission('m1', 'owner_note', deps)).toEqual({ woken: false, reason: 'error' });
  });

  it('never throws — a failing read is reported, not raised', async () => {
    mockFindFirst.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    expect(await wakeMission('m1', 'owner_note', deps)).toEqual({ woken: false, reason: 'error' });
  });
});
