import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── DB mocks ──────────────────────────────────────────────────────────────────

const mockMissionsFindFirst = mock(() => null as any);
const mockMissionsFindMany = mock(() => [] as any[]);
const mockUpdate = mock(() => ({ set: mockUpdateSet }));
const mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));
const mockUpdateWhere = mock(() => Promise.resolve([{ id: 'updated' }]));

/**
 * The two COUNT(*) probes behind the `merged` gate, in the order
 * `missionHasUnmergedWork` runs them:
 *   1. workers ⨝ tasks — workers holding an open PR
 *   2. tasks — non-terminal deliverable rows whose PR has not been opened yet
 *
 * Queued as a list so a test can say "no open PRs, but one task still pending".
 * Default (empty queue) is zero, i.e. nothing outstanding.
 */
let countQueue: number[] = [];
const mockSelectWhere = mock(() => {
  const next = countQueue.shift() ?? 0;
  return Promise.resolve([{ count: next }]) as any;
});

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: {
        findFirst: mockMissionsFindFirst,
        findMany: mockMissionsFindMany,
      },
    },
    update: mockUpdate,
    // db.select({...}).from(t)[.innerJoin(...)].where(expr) → awaitable
    select: () => {
      const node: any = {
        where: mockSelectWhere,
        innerJoin: () => node,
      };
      return { from: () => node };
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  or: (...args: any[]) => ({ type: 'or', args }),
  ne: (a: any, b: any) => ({ type: 'ne', a, b }),
  isNull: (a: any) => ({ type: 'isNull', a }),
  isNotNull: (a: any) => ({ type: 'isNotNull', a }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
  count: () => ({ type: 'count' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: {
    id: 'id',
    dependsOnMissionId: 'depends_on_mission_id',
    gateCondition: 'gate_condition',
    dependencyMetAt: 'dependency_met_at',
  },
  tasks: { id: 'id', missionId: 'mission_id', status: 'status', taskClass: 'task_class' },
  workers: { taskId: 'task_id', prUrl: 'pr_url', mergedAt: 'merged_at' },
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
    mockSelectWhere.mockClear();
    countQueue = [];
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

  // ── The `merged` gate is mission-wide (B13) ───────────────────────────────
  //
  // All three raisers of this signal (the webhook's worker-match and
  // branch-match paths, and the manual merge route) fire on ONE PR merging.
  // Taken at face value that unblocked a downstream mission on 1-of-N while the
  // UI still read "Waiting for mission X PRs to merge".

  it('does NOT unblock on merged while a sibling PR is still open', async () => {
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'merged' },
    ] as any);
    countQueue = [1]; // one worker still holds an open PR

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'merged');

    expect(unblocked).toHaveLength(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does NOT unblock on merged while a deliverable task has yet to open its PR', async () => {
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'merged' },
    ] as any);
    countQueue = [0, 2]; // no open PRs, but two deliverables still moving

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'merged');

    expect(unblocked).toHaveLength(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('unblocks on merged once nothing is outstanding', async () => {
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'merged' },
    ] as any);
    countQueue = [0, 0];

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'merged');

    expect(unblocked).toEqual(['downstream-1']);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('does not probe the mission at all when no dependent waits on this signal', async () => {
    // The predicate costs two COUNT(*) queries, so it must not run on the
    // common path where a merge has no downstream waiter.
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'completed' },
    ] as any);

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'merged');

    expect(unblocked).toHaveLength(0);
    expect(mockSelectWhere).not.toHaveBeenCalled();
  });

  it('leaves the completed signal alone — it is already mission-wide', async () => {
    // `completed` is raised by completeMissionIfVerified, which has already run
    // the whole completion gate. Re-probing PRs there would double-gate it.
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'completed' },
    ] as any);

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'completed');

    expect(unblocked).toEqual(['downstream-1']);
    expect(mockSelectWhere).not.toHaveBeenCalled();
  });

  it('unblocks on completed signal for completed-gate missions', async () => {
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'completed' },
    ]);

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'completed');
    expect(unblocked).toContain('downstream-1');
  });
});
