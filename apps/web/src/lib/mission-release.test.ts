process.env.NODE_ENV = 'test';

import { describe, it, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';

// ── Leaf mocks (behavior varies per test) ─────────────────────────────────────

const mockWorkspacesFindFirst = mock(() => Promise.resolve(null) as any);

// db.select({ count: count() }).from(tasks).where(...) → Promise<[{count}]>
const mockSelectWhere = mock(() => Promise.resolve([{ count: 0 }]) as any);

// db.update(missions).set({...}).where(...).returning({...}) → Promise<Row[]>
const mockReturning = mock(() => Promise.resolve([]) as any);

// ── Module mocks (must appear before the import under test) ───────────────────

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    // Chainable select: db.select({...}).from(t).where(expr) → awaitable
    select: () => ({ from: () => ({ where: mockSelectWhere }) }),
    // Chainable update: db.update(t).set({...}).where(expr).returning({...}) → awaitable
    update: () => ({ set: () => ({ where: () => ({ returning: mockReturning }) }) }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  isNull: (a: any) => ({ type: 'isNull', a }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
  count: () => ({ type: 'count' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id', releasedAt: 'released_at' },
  tasks: { missionId: 'mission_id', status: 'status' },
  workspaces: { id: 'id' },
  githubRepos: { id: 'id' },
}));

mock.module('@buildd/core/release-strategy', () => ({
  resolveReleaseStrategy: (config: any) => {
    if (!config?.enabled) {
      return { ok: false, reason: 'not_configured', message: 'not configured' };
    }
    const kind = config.strategy ?? 'branch_merge';
    if (kind === 'branch_merge') {
      if (!config.prodBranch) {
        return { ok: false, reason: 'invalid', message: 'needs prodBranch' };
      }
      return { ok: true, strategy: { kind, prodBranch: config.prodBranch } };
    }
    if (kind === 'workflow_dispatch') {
      return {
        ok: true,
        strategy: {
          kind,
          workflowFile: config.workflowFile ?? 'release.yml',
          ref: config.ref ?? 'dev',
          inputs: config.inputs ?? {},
        },
      };
    }
    return { ok: false, reason: 'invalid', message: `unknown strategy ${kind}` };
  },
}));

mock.module('@/lib/github', () => ({
  githubApi: mock(() => Promise.resolve(null) as any),
}));

// ── Import module under test ───────────────────────────────────────────────────

import { fireMissionReleaseIfComplete } from './mission-release';

// Spy on executeRelease instead of mock.module()'ing '@/lib/release-executor' —
// mock.module() replaces the module in the global registry for the whole test
// run, which poisons release-executor.test.ts (it imports the same module via
// './release-executor' and would get this mock instead of the real
// implementation). spyOn + mockRestore() properly unwinds after this file.
import * as releaseExecutorModule from './release-executor';
const mockExecuteRelease = spyOn(releaseExecutorModule, 'executeRelease');
afterAll(() => mockExecuteRelease.mockRestore());

// ── Helpers ───────────────────────────────────────────────────────────────────

const ON_MISSION_WORKSPACE = {
  releaseConfig: {
    enabled: true,
    strategy: 'branch_merge',
    prodBranch: 'main',
    trigger: 'on_mission_complete',
  },
  githubRepoId: 'repo-1',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('fireMissionReleaseIfComplete', () => {
  beforeEach(() => {
    mockWorkspacesFindFirst.mockReset();
    mockExecuteRelease.mockReset();
    mockSelectWhere.mockReset();
    mockReturning.mockReset();

    // Defaults: no pending tasks, claim wins, release succeeds
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockReturning.mockResolvedValue([{ id: 'mission-1' }]);
    mockExecuteRelease.mockResolvedValue({ status: 'completed', message: 'done' });
  });

  // ── Trigger-policy gates ──────────────────────────────────────────────────

  it('skips when trigger=manual — no claim attempt, no release', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: {
        enabled: true,
        strategy: 'branch_merge',
        prodBranch: 'main',
        trigger: 'manual',
      },
      githubRepoId: 'repo-1',
    });

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockReturning).not.toHaveBeenCalled();
    expect(mockExecuteRelease).not.toHaveBeenCalled();
  });

  it('skips when trigger=every_merge — no claim attempt, no release', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: {
        enabled: true,
        strategy: 'branch_merge',
        prodBranch: 'main',
        trigger: 'every_merge',
      },
      githubRepoId: 'repo-1',
    });

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockReturning).not.toHaveBeenCalled();
    expect(mockExecuteRelease).not.toHaveBeenCalled();
  });

  it('skips when trigger absent (null config) — no release', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({
      releaseConfig: null,
      githubRepoId: 'repo-1',
    });

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockExecuteRelease).not.toHaveBeenCalled();
  });

  // ── Pending-task gate ─────────────────────────────────────────────────────

  it('skips when pending tasks remain in the mission', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ON_MISSION_WORKSPACE);
    mockSelectWhere.mockResolvedValue([{ count: 2 }]);

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockReturning).not.toHaveBeenCalled();
    expect(mockExecuteRelease).not.toHaveBeenCalled();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('fires executeRelease(isMissionRelease=true) for branch_merge when all tasks are terminal', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ON_MISSION_WORKSPACE);
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);
    mockReturning.mockResolvedValue([{ id: 'mission-1' }]); // claim won

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockExecuteRelease).toHaveBeenCalledTimes(1);
    expect(mockExecuteRelease).toHaveBeenCalledWith({
      taskId: 'task-1',
      workerId: 'worker-1',
      workspaceId: 'ws-1',
      isMissionRelease: true,
    });
  });

  // ── Dedup / concurrency ───────────────────────────────────────────────────

  it('deduplicates concurrent completions — exactly one release fires', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ON_MISSION_WORKSPACE);
    // Both callers observe 0 pending tasks
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);

    // Simulate DB atomicity: first UPDATE (releasedAt IS NULL) wins;
    // second UPDATE hits a non-null releasedAt and returns no rows.
    let claimCalls = 0;
    mockReturning.mockImplementation(() => {
      claimCalls++;
      return Promise.resolve(claimCalls === 1 ? [{ id: 'mission-1' }] : []);
    });

    await Promise.all([
      fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-a', 'worker-a'),
      fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-b', 'worker-b'),
    ]);

    expect(mockExecuteRelease).toHaveBeenCalledTimes(1);
  });

  it('does not fire release when releasedAt claim is already taken', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ON_MISSION_WORKSPACE);
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);
    // Another caller already set releasedAt → no rows returned
    mockReturning.mockResolvedValue([]);

    await fireMissionReleaseIfComplete('ws-1', 'mission-1', 'task-1', 'worker-1');

    expect(mockExecuteRelease).not.toHaveBeenCalled();
  });
});
