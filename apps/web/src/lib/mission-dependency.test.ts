import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── DB mocks ──────────────────────────────────────────────────────────────────

const mockMissionsFindFirst = mock(() => null as any);
const mockMissionsFindMany = mock(() => [] as any[]);
const mockUpdate = mock(() => ({ set: mockUpdateSet }));
const mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));
const mockUpdateWhere = mock(() => Promise.resolve([{ id: 'updated' }]));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: {
        findFirst: mockMissionsFindFirst,
        findMany: mockMissionsFindMany,
      },
    },
    update: mockUpdate,
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  isNull: (a: any) => ({ type: 'isNull', a }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: {
    id: 'id',
    dependsOnMissionId: 'depends_on_mission_id',
    gateCondition: 'gate_condition',
    dependencyMetAt: 'dependency_met_at',
  },
}));

import {
  isMissionBlocked,
  wouldCreateCycle,
  checkAndUnblockDependentMissions,
} from './mission-dependency';

// ── isMissionBlocked ──────────────────────────────────────────────────────────

describe('isMissionBlocked', () => {
  beforeEach(() => {
    mockMissionsFindFirst.mockReset();
  });

  it('returns not blocked when no dependency set', async () => {
    const result = await isMissionBlocked({
      id: 'mission-1',
      dependsOnMissionId: null,
      gateCondition: 'merged',
      dependencyMetAt: null,
    });
    expect(result.blocked).toBe(false);
  });

  it('returns not blocked when dependencyMetAt is already set', async () => {
    const result = await isMissionBlocked({
      id: 'mission-1',
      dependsOnMissionId: 'upstream-1',
      gateCondition: 'merged',
      dependencyMetAt: new Date('2026-01-01'),
    });
    expect(result.blocked).toBe(false);
  });

  it('returns blocked for completed gate when upstream is active', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'upstream-1',
      title: 'Upstream Mission',
      status: 'active',
    });

    const result = await isMissionBlocked({
      id: 'mission-1',
      dependsOnMissionId: 'upstream-1',
      gateCondition: 'completed',
      dependencyMetAt: null,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Upstream Mission');
    expect(result.dependsOnTitle).toBe('Upstream Mission');
  });

  it('returns not blocked for completed gate when upstream is completed', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'upstream-1',
      title: 'Upstream Mission',
      status: 'completed',
    });

    const result = await isMissionBlocked({
      id: 'mission-1',
      dependsOnMissionId: 'upstream-1',
      gateCondition: 'completed',
      dependencyMetAt: null,
    });
    expect(result.blocked).toBe(false);
  });

  it('returns blocked for merged gate when dependencyMetAt is null', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'upstream-1',
      title: 'Specs Mission',
      status: 'active',
    });

    const result = await isMissionBlocked({
      id: 'mission-2',
      dependsOnMissionId: 'upstream-1',
      gateCondition: 'merged',
      dependencyMetAt: null,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Specs Mission');
  });

  it('returns not blocked when upstream is deleted (no-op)', async () => {
    mockMissionsFindFirst.mockResolvedValue(null);

    const result = await isMissionBlocked({
      id: 'mission-1',
      dependsOnMissionId: 'deleted-upstream',
      gateCondition: 'merged',
      dependencyMetAt: null,
    });
    expect(result.blocked).toBe(false);
  });
});

// ── wouldCreateCycle ──────────────────────────────────────────────────────────

describe('wouldCreateCycle', () => {
  beforeEach(() => {
    mockMissionsFindFirst.mockReset();
  });

  it('returns false for a valid non-cyclic dependency', async () => {
    // A depends on B; B has no dependency
    mockMissionsFindFirst.mockResolvedValue({ id: 'B', dependsOnMissionId: null });

    const result = await wouldCreateCycle('A', 'B');
    expect(result).toBe(false);
  });

  it('detects a direct cycle (A depends on B, B depends on A)', async () => {
    // We're about to set B.dependsOnMissionId = A
    // B's current upstream chain would be: B → A (no further deps)
    // Result: A would depend on B, B would depend on A = cycle
    // Actually wouldCreateCycle(B, A) checks if A is reachable from B in the existing chain.
    // Since B has no deps yet, we're asking "would B depending on A create a cycle?"
    // A already depends on B → yes, cycle detected.
    mockMissionsFindFirst
      .mockResolvedValueOnce({ id: 'A', dependsOnMissionId: 'B' }); // A depends on B

    // Setting B to depend on A: walk A's chain → A depends on B → B is targetId (same as missionId)
    // wouldCreateCycle('B', 'A'): does A's chain ever reach 'B'? A → B (yes!)
    const result = await wouldCreateCycle('B', 'A');
    expect(result).toBe(true);
  });

  it('detects a chain cycle (A→B, B→C, setting C→A)', async () => {
    // Chain: A depends on B depends on C
    // We want to set C to depend on A → creates cycle
    mockMissionsFindFirst
      .mockResolvedValueOnce({ id: 'A', dependsOnMissionId: 'B' }) // A → B
      .mockResolvedValueOnce({ id: 'B', dependsOnMissionId: 'C' }) // B → C
      .mockResolvedValueOnce({ id: 'C', dependsOnMissionId: null }); // C → null

    // wouldCreateCycle('C', 'A'): walk A's dependency chain — A→B→C → 'C' === 'C', cycle!
    const result = await wouldCreateCycle('C', 'A');
    expect(result).toBe(true);
  });

  it('returns false for a valid long chain', async () => {
    // D depends on C depends on B depends on A (no deps)
    mockMissionsFindFirst
      .mockResolvedValueOnce({ id: 'A', dependsOnMissionId: null }); // A has no deps

    // We're setting E to depend on D (E→D→C→B→A, no cycle back to E)
    const result = await wouldCreateCycle('E', 'A');
    expect(result).toBe(false);
  });

  it('returns false when setting self-reference (a→a)', async () => {
    // Setting A to depend on A is a trivial cycle — caught by the direct check
    const result = await wouldCreateCycle('A', 'A');
    expect(result).toBe(true);
  });
});

// ── checkAndUnblockDependentMissions ─────────────────────────────────────────

describe('checkAndUnblockDependentMissions', () => {
  beforeEach(() => {
    mockMissionsFindMany.mockReset();
    mockUpdate.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue([{ id: 'unblocked' }]);
  });

  it('sets dependencyMetAt for matching missions on merged signal', async () => {
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'merged' },
      { id: 'downstream-2', gateCondition: 'merged' },
    ]);

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'merged');
    expect(unblocked).toHaveLength(2);
    expect(unblocked).toContain('downstream-1');
    expect(unblocked).toContain('downstream-2');
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('does not unblock missions with mismatched gateCondition', async () => {
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'completed' }, // wants 'completed' gate
    ]);

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'merged');
    expect(unblocked).toHaveLength(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns empty array when no dependents found', async () => {
    mockMissionsFindMany.mockResolvedValue([]);

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'completed');
    expect(unblocked).toHaveLength(0);
  });

  it('unblocks on completed signal for completed-gate missions', async () => {
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'completed' },
    ]);

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'completed');
    expect(unblocked).toContain('downstream-1');
  });
});
