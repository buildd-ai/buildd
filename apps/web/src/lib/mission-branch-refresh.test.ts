/**
 * Keeping a mission's integration branch current with dev
 * (docs/design/mission-delivery-arc.md P5, superseded).
 *
 * The interesting behaviour is the two debounce mechanisms (single-flight
 * lease, idempotency-by-sha) and the 409 → exactly-one-conflict-task rule —
 * everything else is a thin wrapper over GitHub's merges API. A tiny in-memory
 * "mission row" simulates the atomic UPDATE...WHERE claims for real, so the
 * concurrency tests exercise the actual race rather than asserting mocks were
 * called.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── In-memory mission row + DB mock ─────────────────────────────────────────

let missionRow: any;
let tasksById: Record<string, any> = {};
let nextTaskId = 1;
const insertedNotes: any[] = [];
const insertedTasks: any[] = [];

function resetFixtures() {
  missionRow = {
    id: 'm-1',
    title: 'Example Mission',
    status: 'active',
    workspaceId: 'ws-1',
    workingBranch: 'mission/example-slug-0a1b2c3d',
    integrationBranchEnabled: true,
    branchRefreshHeadSha: null,
    branchRefreshLeaseUntil: null,
    branchRefreshConflictTaskId: null,
  };
  tasksById = {};
  nextTaskId = 1;
  insertedNotes.length = 0;
  insertedTasks.length = 0;
}
resetFixtures();

const mockMissionsFindMany = mock(() => Promise.resolve([]) as any);
const mockWorkspacesFindFirst = mock(() =>
  Promise.resolve({
    id: 'ws-1',
    githubRepoId: 'repo-1',
    githubInstallationId: 4242,
    gitConfig: { targetBranch: 'dev' },
  }) as any,
);
const mockWorkspacesFindMany = mock(() => Promise.resolve([]) as any);
const mockGithubReposFindFirst = mock(() =>
  Promise.resolve({
    fullName: 'buildd-ai/buildd',
    defaultBranch: 'dev',
    installation: { installationId: 4242 },
  }) as any,
);
const mockResolveMissionRepoWorkspaceId = mock(() => Promise.resolve({ workspaceId: 'ws-1' }) as any);
const mockEnsureMissionIntegrationBranch = mock(() =>
  Promise.resolve({ ok: true, branch: missionRow.workingBranch, created: false }) as any,
);
const mockFindMissionPrOwner = mock(() => Promise.resolve(null) as any);
const mockGithubApi = mock((_installationId: number, path: string, _options?: any) => {
  if (path.endsWith('/git/ref/heads/dev')) {
    return Promise.resolve({ object: { sha: 'dev-sha-current' } });
  }
  return Promise.resolve(null);
});
const mockAnnounceTaskCreated = mock(() => Promise.resolve());
const mockWakeTask = mock(() => Promise.resolve());
const mockFireGateEvent = mock((_input: any) => 'friction-sig');
const gateEvents: any[] = [];
const mockWorkspaceRepoMatches = mock((_repo: string) => ({ __matches: true }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: {
        findFirst: (..._args: any[]) => Promise.resolve({ ...missionRow }),
        findMany: (...args: any[]) => mockMissionsFindMany(...args),
      },
      workspaces: {
        findFirst: (...args: any[]) => mockWorkspacesFindFirst(...args),
        findMany: (...args: any[]) => mockWorkspacesFindMany(...args),
      },
      githubRepos: { findFirst: (...args: any[]) => mockGithubReposFindFirst(...args) },
      tasks: {
        findFirst: (args: any) => {
          const id = args?.where?.[1] ?? args?.where?.value ?? args?.where;
          const task = typeof id === 'string' ? tasksById[id] : undefined;
          return Promise.resolve(task ?? null);
        },
      },
    },
    update: (table: any) => makeUpdateChain(table),
    insert: (table: any) => makeInsertChain(table),
  },
}));

function makeUpdateChain(table: any) {
  let setVals: any;
  const exec = () => {
    if (table === 'missions') {
      if (Object.prototype.hasOwnProperty.call(setVals, 'branchRefreshLeaseUntil')) {
        const claiming = setVals.branchRefreshLeaseUntil instanceof Date;
        if (claiming) {
          const held = missionRow.branchRefreshLeaseUntil instanceof Date
            ? missionRow.branchRefreshLeaseUntil.getTime() > Date.now()
            : false;
          if (held) return { rows: [] };
          missionRow.branchRefreshLeaseUntil = setVals.branchRefreshLeaseUntil;
          return { rows: [{ id: missionRow.id }] };
        }
        missionRow.branchRefreshLeaseUntil = null;
        return { rows: [{ id: missionRow.id }] };
      }
      if (Object.prototype.hasOwnProperty.call(setVals, 'branchRefreshHeadSha')) {
        missionRow.branchRefreshHeadSha = setVals.branchRefreshHeadSha;
      }
      if (Object.prototype.hasOwnProperty.call(setVals, 'branchRefreshConflictTaskId')) {
        missionRow.branchRefreshConflictTaskId = setVals.branchRefreshConflictTaskId;
      }
      return { rows: [{ id: missionRow.id }] };
    }
    return { rows: [] };
  };
  const chain: any = {
    set(v: any) {
      setVals = v;
      return chain;
    },
    where(_w: any) {
      return chain;
    },
    returning(_sel?: any) {
      return Promise.resolve(exec().rows);
    },
    then(resolve: any, reject: any) {
      return Promise.resolve(exec()).then(() => resolve(undefined), reject);
    },
    catch(reject: any) {
      return Promise.resolve(exec()).then(() => undefined).catch(reject);
    },
  };
  return chain;
}

function makeInsertChain(table: any) {
  return {
    values: (v: any) => {
      if (table === 'tasks') {
        const id = `task-${nextTaskId++}`;
        const row = { id, status: 'pending', ...v };
        tasksById[id] = row;
        insertedTasks.push(row);
        return {
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([row]) }),
        };
      }
      if (table === 'missionNotes') {
        insertedNotes.push(v);
        return Promise.resolve();
      }
      return Promise.resolve();
    },
  };
}

mock.module('@buildd/core/db/schema', () => ({
  missions: 'missions',
  missionNotes: 'missionNotes',
  tasks: 'tasks',
  workspaces: 'workspaces',
  githubRepos: 'githubRepos',
}));

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => args,
  and: (...args: any[]) => args,
  inArray: (...args: any[]) => args,
  isNull: (field: any) => ({ isNull: field }),
  lt: (...args: any[]) => args,
  or: (...args: any[]) => args,
  sql: (...args: any[]) => args,
}));

mock.module('@buildd/shared', () => ({
  TERMINAL_TASK_STATUSES: ['completed', 'failed', 'cancelled'],
}));

mock.module('@buildd/core/mission-integration', () => ({
  missionIntegrationBase: (m: any) =>
    m?.integrationBranchEnabled && m?.workingBranch?.trim() ? m.workingBranch.trim() : null,
}));

mock.module('@/lib/github', () => ({
  githubApi: (...args: any[]) => mockGithubApi(...(args as [any, any, any])),
}));

mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: { MISSION_BRANCH_REFRESH: 'mission_branch_refresh' },
  fireGateEvent: (input: any) => {
    gateEvents.push(input);
    return mockFireGateEvent(input);
  },
}));

mock.module('@/lib/dispatch-authority', () => ({
  announceTaskCreated: (...args: any[]) => mockAnnounceTaskCreated(...args),
  wakeTask: (...args: any[]) => mockWakeTask(...args),
}));

mock.module('@/lib/mission-repo-workspace', () => ({
  resolveMissionRepoWorkspaceId: (...args: any[]) => mockResolveMissionRepoWorkspaceId(...args),
}));

mock.module('@/lib/mission-integration-branch', () => ({
  ensureMissionIntegrationBranch: (...args: any[]) => mockEnsureMissionIntegrationBranch(...args),
}));

mock.module('@/lib/mission-pr', () => ({
  findMissionPrOwner: (...args: any[]) => mockFindMissionPrOwner(...args),
}));

mock.module('@/lib/repo-scope', () => ({
  workspaceRepoMatches: (...args: any[]) => mockWorkspaceRepoMatches(...args),
}));

const {
  refreshMissionIntegrationBranch,
  sweepMissionBranchRefresh,
  refreshMissionBranchesForTrunkMerge,
} = await import('./mission-branch-refresh');

function githubError(status: number, body: unknown): Error {
  return new Error(`GitHub API error: ${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`);
}

describe('refreshMissionIntegrationBranch', () => {
  beforeEach(() => {
    resetFixtures();
    mockMissionsFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockGithubApi.mockReset();
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
      return Promise.resolve(null);
    }) as any);
    mockEnsureMissionIntegrationBranch.mockReset();
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: missionRow.workingBranch, created: false });
    mockFindMissionPrOwner.mockReset();
    mockFindMissionPrOwner.mockResolvedValue(null);
    mockAnnounceTaskCreated.mockReset();
    mockAnnounceTaskCreated.mockResolvedValue(undefined);
    mockWakeTask.mockReset();
    mockWakeTask.mockResolvedValue(undefined);
    mockFireGateEvent.mockReset();
    gateEvents.length = 0;
  });

  it('merges dev into the integration branch cleanly and dispatches nothing', async () => {
    mockGithubApi.mockImplementation(((_i: number, path: string, opts?: any) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
      if (path.endsWith('/merges') && opts?.method === 'POST') {
        return Promise.resolve({ sha: 'merge-commit-sha' });
      }
      return Promise.resolve(null);
    }) as any);

    const outcome = await refreshMissionIntegrationBranch('m-1');

    expect(outcome).toEqual({ kind: 'merged', headSha: 'dev-sha-current' });
    expect(missionRow.branchRefreshHeadSha).toBe('dev-sha-current');
    expect(missionRow.branchRefreshLeaseUntil).toBeNull();
    expect(insertedTasks.length).toBe(0);
    expect(gateEvents.some(e => e.outcome === 'accepted')).toBe(true);
  });

  it('treats a 204 (already merged) as already-current with no gate event', async () => {
    mockGithubApi.mockImplementation(((_i: number, path: string, opts?: any) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
      if (path.endsWith('/merges') && opts?.method === 'POST') return Promise.resolve(null); // 204
      return Promise.resolve(null);
    }) as any);

    const outcome = await refreshMissionIntegrationBranch('m-1');

    expect(outcome).toEqual({ kind: 'skipped', reason: 'already_current' });
    expect(missionRow.branchRefreshHeadSha).toBe('dev-sha-current');
    expect(gateEvents.length).toBe(0);
  });

  it('a 409 dispatches exactly one conflict task, and a second refresh while it is open dispatches none', async () => {
    mockGithubApi.mockImplementation(((_i: number, path: string, opts?: any) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
      if (path.endsWith('/merges') && opts?.method === 'POST') {
        return Promise.reject(githubError(409, { message: 'Merge conflict' }));
      }
      return Promise.resolve(null);
    }) as any);

    const first = await refreshMissionIntegrationBranch('m-1');
    expect(first.kind).toBe('conflict');
    expect((first as any).dispatched).toBe(true);
    expect(insertedTasks.length).toBe(1);
    expect(missionRow.branchRefreshConflictTaskId).toBe(insertedTasks[0].id);
    expect(gateEvents.some(e => e.outcome === 'stranded')).toBe(true);

    // dev advances further while the conflict task is still open (pending).
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-even-newer' } });
      return Promise.resolve(null);
    }) as any);

    const second = await refreshMissionIntegrationBranch('m-1');
    expect(second).toEqual({ kind: 'skipped', reason: 'conflict_task_open', conflictTaskId: insertedTasks[0].id });
    expect(insertedTasks.length).toBe(1); // no second task
  });

  it('self-heals and resumes refreshing once the conflict task reaches a terminal status', async () => {
    missionRow.branchRefreshConflictTaskId = 'task-old';
    tasksById['task-old'] = { id: 'task-old', status: 'completed' };
    mockGithubApi.mockImplementation(((_i: number, path: string, opts?: any) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
      if (path.endsWith('/merges') && opts?.method === 'POST') return Promise.resolve({ sha: 'merge-sha' });
      return Promise.resolve(null);
    }) as any);

    const outcome = await refreshMissionIntegrationBranch('m-1');

    expect(outcome.kind).toBe('merged');
    expect(missionRow.branchRefreshConflictTaskId).toBeNull();
  });

  it('debounces a concurrent burst: only one caller actually hits the GitHub merges API', async () => {
    let mergeCalls = 0;
    mockGithubApi.mockImplementation(((_i: number, path: string, opts?: any) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
      if (path.endsWith('/merges') && opts?.method === 'POST') {
        mergeCalls++;
        return Promise.resolve({ sha: 'merge-sha' });
      }
      return Promise.resolve(null);
    }) as any);

    const [a, b, c] = await Promise.all([
      refreshMissionIntegrationBranch('m-1'),
      refreshMissionIntegrationBranch('m-1'),
      refreshMissionIntegrationBranch('m-1'),
    ]);

    const outcomes = [a, b, c];
    expect(outcomes.filter(o => o.kind === 'merged').length).toBe(1);
    expect(outcomes.filter(o => o.kind === 'skipped' && (o as any).reason === 'in_flight').length).toBe(2);
    expect(mergeCalls).toBe(1);
  });

  it('a later trigger for the same dev state is a no-op (sha already recorded)', async () => {
    missionRow.branchRefreshHeadSha = 'dev-sha-current';

    const outcome = await refreshMissionIntegrationBranch('m-1');

    expect(outcome).toEqual({ kind: 'skipped', reason: 'already_current' });
  });

  it('skips a completed mission', async () => {
    missionRow.status = 'completed';
    const outcome = await refreshMissionIntegrationBranch('m-1');
    expect(outcome).toEqual({ kind: 'skipped', reason: 'mission_terminal', detail: 'completed' });
  });

  it('skips an archived mission', async () => {
    missionRow.status = 'archived';
    const outcome = await refreshMissionIntegrationBranch('m-1');
    expect(outcome).toEqual({ kind: 'skipped', reason: 'mission_terminal', detail: 'archived' });
  });

  it('skips a mission not opted into an integration branch', async () => {
    missionRow.integrationBranchEnabled = false;
    const outcome = await refreshMissionIntegrationBranch('m-1');
    expect(outcome).toEqual({ kind: 'skipped', reason: 'not_opted_in' });
  });

  it('skips once the mission PR has already merged', async () => {
    mockFindMissionPrOwner.mockResolvedValue({ state: 'merged', prNumber: 1, prUrl: 'x', workerId: 'w', taskId: 't', mergedAt: new Date() });
    const outcome = await refreshMissionIntegrationBranch('m-1');
    expect(outcome).toEqual({ kind: 'skipped', reason: 'mission_pr_merged' });
  });
});

describe('sweepMissionBranchRefresh', () => {
  beforeEach(() => {
    resetFixtures();
    mockMissionsFindMany.mockReset();
    mockGithubApi.mockReset();
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
      return Promise.resolve(null);
    }) as any);
  });

  it('scans every candidate the query returns and tallies outcomes', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'm-1' }]);
    missionRow.branchRefreshHeadSha = 'dev-sha-current'; // already current → skipped

    const result = await sweepMissionBranchRefresh();

    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('is a no-op backstop when nothing is eligible', async () => {
    mockMissionsFindMany.mockResolvedValue([]);
    const result = await sweepMissionBranchRefresh();
    expect(result).toEqual({ scanned: 0, merged: 0, conflicts: 0, skipped: 0, errors: 0 });
  });
});

describe('refreshMissionBranchesForTrunkMerge', () => {
  beforeEach(() => {
    resetFixtures();
    mockWorkspacesFindMany.mockReset();
    mockMissionsFindMany.mockReset();
    mockGithubApi.mockReset();
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
      return Promise.resolve(null);
    }) as any);
  });

  it('does nothing when no workspace trunk matches the merged base ref', async () => {
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', gitConfig: { targetBranch: 'dev' } }]);
    await refreshMissionBranchesForTrunkMerge({ repoFullName: 'buildd-ai/buildd', baseRef: 'some-feature-branch' });
    expect(mockMissionsFindMany).not.toHaveBeenCalled();
  });

  it('refreshes active missions scoped to a workspace whose trunk matches', async () => {
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', gitConfig: { targetBranch: 'dev' } }]);
    mockMissionsFindMany.mockResolvedValue([{ id: 'm-1' }]);
    missionRow.branchRefreshHeadSha = 'dev-sha-current';

    await refreshMissionBranchesForTrunkMerge({ repoFullName: 'buildd-ai/buildd', baseRef: 'dev' });

    expect(mockMissionsFindMany).toHaveBeenCalledTimes(1);
  });
});
