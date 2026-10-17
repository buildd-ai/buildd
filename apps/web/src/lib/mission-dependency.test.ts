import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── DB mocks ──────────────────────────────────────────────────────────────────

const mockMissionsFindFirst = mock(() => null as any);
const mockMissionsFindMany = mock(() => [] as any[]);
const mockUpdate = mock(() => ({ set: mockUpdateSet }));
const mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));
// `.where(...).returning()` — the rows the dependencyMetAt write actually cleared.
let updateReturningRows: any[] = [{ id: 'updated' }];
const mockUpdateWhere = mock(() => ({ returning: () => Promise.resolve(updateReturningRows) }) as any);

// wakeMission is covered in mission-wake.test.ts; here only who gets woken.
const mockWakeMission = mock((_id: string, _reason: string) => Promise.resolve({ woken: true }));
mock.module('@/lib/mission-wake', () => ({
  wakeMission: mockWakeMission,
  wakeMissionAfterResponse: mock(() => {}),
}));

/**
 * The upstream's tasks, each with its latest worker, as `evaluateMissionGate`
 * loads them (db.query.tasks.findMany). The predicate itself is covered in
 * mission-dependency-gate.test.ts; here only how the loader and the writers
 * use its answer.
 */
let upstreamTasks: any[] = [];
const mockTasksFindMany = mock(() => Promise.resolve(upstreamTasks));
const url = (n: number) => `https://github.com/example/app/pull/${n}`;
const row = (title: string, worker: any, over: any = {}) => ({
  id: `task-${title}`, title, status: 'completed', taskClass: 'work', parentTaskId: null, workspaceId: 'ws-1',
  workers: worker ? [worker] : [], ...over,
});
const mergedW = (n: number) => ({ prUrl: url(n), prNumber: n, mergedAt: new Date('2026-01-02'), prLifecycleStatus: 'merged' });
const openW = (n: number) => ({ prUrl: url(n), prNumber: n, mergedAt: null, prLifecycleStatus: 'pr_open' });
const closedW = (n: number) => ({ prUrl: url(n), prNumber: n, mergedAt: null, prLifecycleStatus: 'closed' });

mock.module('@/lib/workflow/delivery-ship', () => ({
  deliveryShipsForPrs: () => Promise.resolve(new Map()),
  shipKey: () => null,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: {
        findFirst: mockMissionsFindFirst,
        findMany: mockMissionsFindMany,
      },
      tasks: { findMany: mockTasksFindMany },
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
  tasks: { id: 'id', missionId: 'mission_id', status: 'status', taskClass: 'task_class' },
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
    mockTasksFindMany.mockClear();
    upstreamTasks = [];
    mockUpdate.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    updateReturningRows = [{ id: 'mission-2' }];
    mockUpdateWhere.mockImplementation(() => ({ returning: () => Promise.resolve(updateReturningRows) }) as any);
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

  it('returns blocked for merged gate while an upstream PR is open, naming the PR', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'upstream-1',
      title: 'Specs Mission',
      status: 'active',
    });
    upstreamTasks = [row('docs: spec', openW(7))];

    const result = await isMissionBlocked({
      id: 'mission-2',
      dependsOnMissionId: 'upstream-1',
      gateCondition: 'merged',
      dependencyMetAt: null,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Waiting for mission "Specs Mission" PRs to merge: PR #7 for "docs: spec" is not merged');
    expect(result.unmet?.[0]).toMatchObject({ kind: 'pr_open', prNumber: 7 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // ── Read-through: the gate is decided from live state, not only from events ──
  //
  // Regression: an upstream mission was completed and delivered (every task PR
  // and its mission PR merged, criteria passed) but its downstream, gated on
  // `merged`, stayed blocked. The merge events had fired while a sibling row was
  // still open, a closed obsolete refresh PR was counted as an open PR forever,
  // and completion only released `completed`-gate dependents. Nothing re-asked.

  it('unblocks and stamps a merged-gate mission whose upstream is completed', async () => {
    mockMissionsFindFirst.mockResolvedValue({ id: 'upstream-1', title: 'Upstream', status: 'completed' });

    const result = await isMissionBlocked({
      id: 'mission-2',
      dependsOnMissionId: 'upstream-1',
      gateCondition: 'merged',
      dependencyMetAt: null,
    });

    expect(result.blocked).toBe(false);
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ dependencyMetAt: expect.any(Date) }));
    // Completion already settled it: no task load, no verification read.
    expect(mockTasksFindMany).not.toHaveBeenCalled();
  });

  it('unblocks a merged-gate mission when every upstream PR shipped, despite a closed refresh PR', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'upstream-1', title: 'Upstream', status: 'active', integrationBranchEnabled: true, workingBranch: 'mission/upstream',
    });
    upstreamTasks = [
      row('feat: build', mergedW(1)),
      row('chore(mission): merge dev into the Upstream integration branch', closedW(2)),
      row('Ship mission: Upstream', mergedW(3), { taskClass: 'bookkeeping' }),
      row('[surface audit] Upstream', null, { status: 'pending', roleSlug: 'visual-auditor' }),
    ];

    const result = await isMissionBlocked({
      id: 'mission-2',
      dependsOnMissionId: 'upstream-1',
      gateCondition: 'merged',
      dependencyMetAt: null,
    });

    expect(result.blocked).toBe(false);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('keeps a mission-branch upstream shut until its mission PR merges', async () => {
    mockMissionsFindFirst.mockResolvedValue({
      id: 'upstream-1', title: 'Upstream', status: 'active', integrationBranchEnabled: true, workingBranch: 'mission/upstream',
    });
    upstreamTasks = [row('feat: build', mergedW(1)), row('Ship mission: Upstream', openW(3), { taskClass: 'bookkeeping' })];

    const result = await isMissionBlocked({
      id: 'mission-2',
      dependsOnMissionId: 'upstream-1',
      gateCondition: 'merged',
      dependencyMetAt: null,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Waiting for mission "Upstream" PRs to merge: the mission PR #3 is not merged');
  });

  it('names the upstream status for a completed gate', async () => {
    mockMissionsFindFirst.mockResolvedValue({ id: 'upstream-1', title: 'Upstream', status: 'active' });
    const result = await isMissionBlocked({
      id: 'mission-2',
      dependsOnMissionId: 'upstream-1',
      gateCondition: 'completed',
      dependencyMetAt: null,
    });
    expect(result.reason).toBe('Waiting for mission "Upstream" to complete: it is active, not completed');
    expect(mockTasksFindMany).not.toHaveBeenCalled();
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
    mockTasksFindMany.mockClear();
    mockMissionsFindFirst.mockReset();
    mockMissionsFindFirst.mockResolvedValue({ id: 'upstream-1', title: 'Upstream', status: 'active' });
    upstreamTasks = [];
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    updateReturningRows = [{ id: 'unblocked' }];
    mockUpdateWhere.mockImplementation(() => ({ returning: () => Promise.resolve(updateReturningRows) }) as any);
    mockWakeMission.mockClear();
  });

  it('wakes each unblocked mission with reason dependency_met', async () => {
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'completed' },
      { id: 'downstream-2', gateCondition: 'completed' },
    ]);

    await checkAndUnblockDependentMissions('upstream-1', 'completed');

    expect(mockWakeMission).toHaveBeenCalledTimes(2);
    expect(mockWakeMission).toHaveBeenCalledWith('downstream-1', 'dependency_met');
    expect(mockWakeMission).toHaveBeenCalledWith('downstream-2', 'dependency_met');
  });

  it('does not wake (or report) a mission whose gate another caller already cleared', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'downstream-1', gateCondition: 'merged' }]);
    upstreamTasks = [row('feat: a', mergedW(1))];
    updateReturningRows = []; // the IS NULL guard matched nothing: a redelivery lost the race

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'merged');

    expect(unblocked).toEqual([]);
    expect(mockWakeMission).not.toHaveBeenCalled();
  });

  it('does not wake anything when the merged gate stays shut', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'downstream-1', gateCondition: 'merged' }]);
    upstreamTasks = [row('feat: a', openW(1))];

    await checkAndUnblockDependentMissions('upstream-1', 'merged');

    expect(mockWakeMission).not.toHaveBeenCalled();
  });

  it('uses an injected wake when given', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'downstream-1', gateCondition: 'completed' }]);
    const injected = mock(() => Promise.resolve());

    await checkAndUnblockDependentMissions('upstream-1', 'completed', { wake: injected });

    expect(injected).toHaveBeenCalledWith('downstream-1', 'dependency_met');
    expect(mockWakeMission).not.toHaveBeenCalled();
  });

  it('sets dependencyMetAt for matching missions on merged signal', async () => {
    upstreamTasks = [row('feat: a', mergedW(1))];
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

  it('the merged signal does not release a completed-gate mission', async () => {
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
    upstreamTasks = [row('feat: a', mergedW(1)), row('feat: b', openW(2))]; // one sibling PR still open

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'merged');

    expect(unblocked).toHaveLength(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does NOT unblock on merged while a deliverable task has yet to open its PR', async () => {
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'merged' },
    ] as any);
    upstreamTasks = [row('feat: a', mergedW(1)), row('feat: b', null, { status: 'in_progress' })];

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'merged');

    expect(unblocked).toHaveLength(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('unblocks on merged once nothing is outstanding', async () => {
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'merged' },
    ] as any);
    upstreamTasks = [row('feat: a', mergedW(1))];

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'merged');

    expect(unblocked).toEqual(['downstream-1']);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('does not probe the mission at all when no dependent waits on this signal', async () => {
    // The predicate loads the upstream's tasks, so it must not run on the
    // common path where a merge has no downstream waiter.
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'completed' },
    ] as any);

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'merged');

    expect(unblocked).toHaveLength(0);
    expect(mockTasksFindMany).not.toHaveBeenCalled();
  });

  it('leaves the completed signal alone — it is already mission-wide', async () => {
    // `completed` is raised by completeMissionIfVerified, which has already run
    // the whole completion gate. Re-probing PRs there would double-gate it.
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'completed' },
    ] as any);

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'completed');

    expect(unblocked).toEqual(['downstream-1']);
    expect(mockTasksFindMany).not.toHaveBeenCalled();
  });

  it('the completed signal also releases merged-gate missions: completion already settled every PR', async () => {
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-merged', gateCondition: 'merged' },
      { id: 'downstream-completed', gateCondition: 'completed' },
    ]);

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'completed');

    expect(unblocked).toEqual(['downstream-merged', 'downstream-completed']);
    expect(mockTasksFindMany).not.toHaveBeenCalled();
  });

  it('unblocks on completed signal for completed-gate missions', async () => {
    mockMissionsFindMany.mockResolvedValue([
      { id: 'downstream-1', gateCondition: 'completed' },
    ]);

    const unblocked = await checkAndUnblockDependentMissions('upstream-1', 'completed');
    expect(unblocked).toContain('downstream-1');
  });
});
