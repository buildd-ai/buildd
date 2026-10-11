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
/** taskId → the worker row carrying its PR (the conflict task's PR). */
let prWorkerByTaskId: Record<string, { prNumber: number }> = {};
let nextTaskId = 1;
const insertedNotes: any[] = [];
const insertedTasks: any[] = [];
const mockTaskInsert = mock(() => Promise.resolve());

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
  prWorkerByTaskId = {};
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
      workers: {
        findFirst: (args: any) => {
          const taskId = args?.where?.args?.[0]?.args?.[1];
          return Promise.resolve(prWorkerByTaskId[taskId] ?? null);
        },
      },
      tasks: {
        findFirst: (args: any) => {
          const id = args?.where?.args?.[1];
          const task = typeof id === 'string' ? tasksById[id] : undefined;
          return Promise.resolve(task ?? null);
        },
      },
    },
    update: (table: any) => makeUpdateChain(table),
    insert: (table: any) => makeInsertChain(table),
  },
}));

function matches(p: any): boolean {
  if ('isNull' in p) return missionRow[p.isNull] == null;
  if (p.op === 'and') return p.args.every(matches);
  if (p.op === 'or') return p.args.some(matches);
  const [field, value] = p.args;
  const actual = missionRow[field];
  if (p.op === 'lt') return actual != null && actual < value;
  return actual instanceof Date && value instanceof Date
    ? actual.getTime() === value.getTime() : actual === value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function makeUpdateChain(table: any) {
  let setVals: any;
  let predicate: any;
  const exec = () => {
    if (String(table) === 'missions') {
      if (predicate && !matches(predicate)) return { rows: [] };
      if (Object.prototype.hasOwnProperty.call(setVals, 'branchRefreshLeaseToken')) missionRow.branchRefreshLeaseToken = setVals.branchRefreshLeaseToken;
      if (Object.prototype.hasOwnProperty.call(setVals, 'branchRefreshLeaseUntil')) {
        const claiming = setVals.branchRefreshLeaseUntil instanceof Date;
        if (claiming) {
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
    if (String(table) === 'tasks') {
      const id = predicate?.args?.[1];
      if (tasksById[id] && setVals?.context) tasksById[id] = { ...tasksById[id], context: setVals.context };
    }
    return { rows: [] };
  };
  const chain: any = {
    set(v: any) {
      setVals = v;
      return chain;
    },
    where(w: any) {
      predicate = w;
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
        const id = v.id ?? `task-${nextTaskId++}`;
        const row = { id, status: 'pending', ...v };
        return {
          onConflictDoNothing: () => ({ returning: async () => {
            await mockTaskInsert();
            tasksById[id] = row;
            insertedTasks.push(row);
            return [row];
          } }),
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
  missions: Object.assign(new String('missions'), Object.fromEntries(['id', 'branchRefreshLeaseUntil', 'branchRefreshLeaseToken', 'branchRefreshConflictTaskId'].map(k => [k, k]))),
  missionNotes: 'missionNotes',
  tasks: 'tasks',
  workers: { taskId: 'taskId', prNumber: 'prNumber', createdAt: 'createdAt' },
  workspaces: 'workspaces',
  githubRepos: 'githubRepos',
}));

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ op: 'eq', args }),
  and: (...args: any[]) => ({ op: 'and', args }),
  inArray: (...args: any[]) => args,
  isNull: (field: any) => ({ isNull: field }),
  isNotNull: (field: any) => ({ isNotNull: field }),
  desc: (field: any) => ({ desc: field }),
  lt: (...args: any[]) => ({ op: 'lt', args }),
  or: (...args: any[]) => ({ op: 'or', args }),
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
    mockTaskInsert.mockReset();
    mockTaskInsert.mockResolvedValue(undefined);
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

  it('rechecks the conflict pointer when a delayed reader acquires the released lease', async () => {
    const entered = deferred<void>();
    const resume = deferred<any>();
    mockFindMissionPrOwner.mockImplementationOnce(() => { entered.resolve(); return resume.promise; });
    let merges = 0;
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/merges')) { merges++; return Promise.reject(githubError(409, 'conflict')); }
      return Promise.resolve({ object: { sha: 'dev-new' } });
    }) as any);
    const delayed = refreshMissionIntegrationBranch('m-1');
    await entered.promise;
    await refreshMissionIntegrationBranch('m-1');
    resume.resolve(null);
    expect(await delayed).toMatchObject({ kind: 'skipped', reason: 'conflict_task_open' });
    expect(insertedTasks).toHaveLength(1);
    expect(merges).toBe(1);
  });

  it('an expired caller cannot dispatch twice or release its successor lease', async () => {
    const entered = deferred<void>();
    const resume = deferred<any>();
    let merges = 0;
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/merges')) {
        merges++;
        if (merges === 1) { entered.resolve(); return resume.promise; }
        return Promise.reject(githubError(409, 'conflict'));
      }
      return Promise.resolve({ object: { sha: 'dev-new' } });
    }) as any);
    const expired = refreshMissionIntegrationBranch('m-1');
    await entered.promise;
    missionRow.branchRefreshLeaseUntil = new Date(Date.now() - 1);
    const announced = deferred<void>();
    const finishAnnouncement = deferred<void>();
    mockAnnounceTaskCreated.mockImplementationOnce(() => { announced.resolve(); return finishAnnouncement.promise; });
    const successor = refreshMissionIntegrationBranch('m-1');
    await announced.promise;
    const successorLease = missionRow.branchRefreshLeaseUntil;
    resume.resolve(Promise.reject(githubError(409, 'conflict')));
    await expired;
    expect(missionRow.branchRefreshLeaseUntil).toEqual(successorLease);
    expect(insertedTasks).toHaveLength(1);
    expect(await refreshMissionIntegrationBranch('m-1')).toMatchObject({ kind: 'skipped', reason: 'in_flight' });
    expect(merges).toBe(2);
    finishAnnouncement.resolve();
    await successor;
    expect(await refreshMissionIntegrationBranch('m-1')).toMatchObject({ kind: 'skipped', reason: 'conflict_task_open' });
    expect(merges).toBe(2);
    expect(insertedTasks).toHaveLength(1);
  });

  it('does not merge after its lease expires and a successor opens a conflict task', async () => {
    const entered = deferred<void>();
    const resume = deferred<any>();
    mockEnsureMissionIntegrationBranch.mockImplementationOnce(() => { entered.resolve(); return resume.promise; });
    let merges = 0;
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/merges')) { merges++; return Promise.reject(githubError(409, 'conflict')); }
      return Promise.resolve({ object: { sha: 'dev-new' } });
    }) as any);
    const expired = refreshMissionIntegrationBranch('m-1');
    await entered.promise;
    missionRow.branchRefreshLeaseUntil = new Date(Date.now() - 1);
    await refreshMissionIntegrationBranch('m-1');
    resume.resolve({ ok: true, created: false, branch: missionRow.workingBranch });
    await expired;
    expect(merges).toBe(1);
    expect(insertedTasks).toHaveLength(1);
  });

  it('keeps an in-progress task reservation when insertion outlives the lease', async () => {
    const entered = deferred<void>();
    const resume = deferred<void>();
    mockTaskInsert.mockImplementationOnce(() => { entered.resolve(); return resume.promise; });
    let merges = 0;
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/merges')) { merges++; return Promise.reject(githubError(409, 'conflict')); }
      return Promise.resolve({ object: { sha: 'dev-new' } });
    }) as any);
    const first = refreshMissionIntegrationBranch('m-1');
    await entered.promise;
    expect(insertedTasks).toHaveLength(0);
    missionRow.branchRefreshLeaseUntil = new Date(Date.now() - 1);
    expect(await refreshMissionIntegrationBranch('m-1')).toMatchObject({ kind: 'skipped', reason: 'conflict_task_open' });
    resume.resolve();
    await first;
    expect(insertedTasks).toHaveLength(1);
    expect(merges).toBe(1);
  });

  it('clears its reservation and releases the lease if task insertion fails', async () => {
    mockTaskInsert.mockRejectedValueOnce(new Error('insert failed'));
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/merges')) return Promise.reject(githubError(409, 'conflict'));
      return Promise.resolve({ object: { sha: 'dev-new' } });
    }) as any);
    await expect(refreshMissionIntegrationBranch('m-1')).rejects.toThrow('insert failed');
    expect(missionRow.branchRefreshConflictTaskId).toBeNull();
    expect(missionRow.branchRefreshLeaseUntil).toBeNull();
    expect(missionRow.branchRefreshLeaseToken).toBeNull();
    expect(insertedTasks).toHaveLength(0);
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

  it('records what the refresh must prove on the conflict task it dispatches', async () => {
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
      if (path.endsWith('/git/ref/heads/mission/example-slug-0a1b2c3d')) return Promise.resolve({ object: { sha: 'mission-head-0' } });
      if (path.endsWith('/merges')) return Promise.reject(githubError(409, 'conflict'));
      return Promise.resolve(null);
    }) as any);

    await refreshMissionIntegrationBranch('m-1');

    expect(insertedTasks).toHaveLength(1);
    expect(insertedTasks[0].context).toMatchObject({
      requireMergeCommit: true,
      refreshTrunk: 'dev',
      refreshTrunkSha: 'dev-sha-current',
      refreshMissionHeadSha: 'mission-head-0',
    });
    expect(insertedTasks[0].description).toContain('dev-sha'.slice(0, 7));
  });

  describe('settling a finished conflict task by its PR', () => {
    const BRANCH_HEAD_PATH = '/git/ref/heads/mission/example-slug-0a1b2c3d';
    /**
     * GitHub, as far as settlement reads it: dev's head, the PR, the branch head,
     * and compare statuses keyed by `ancestor...head`.
     */
    function github(opts: {
      devSha?: string;
      pr?: { state: string; merged: boolean; head: { sha: string } } | Error;
      branchHead?: string;
      compare?: Record<string, string>;
      merges?: () => Promise<any>;
    }) {
      const calls = { merges: 0 };
      mockGithubApi.mockImplementation(((_i: number, path: string) => {
        if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: opts.devSha ?? 'dev-sha-current' } });
        if (path.endsWith(BRANCH_HEAD_PATH)) return Promise.resolve({ object: { sha: opts.branchHead ?? 'branch-head' } });
        if (/\/pulls\/\d+$/.test(path)) return opts.pr instanceof Error ? Promise.reject(opts.pr) : Promise.resolve(opts.pr ?? null);
        const cmp = /\/compare\/(.+)$/.exec(path);
        if (cmp) {
          const status = opts.compare?.[cmp[1]];
          return status ? Promise.resolve({ status }) : Promise.reject(githubError(404, 'no compare'));
        }
        if (path.endsWith('/merges')) { calls.merges++; return opts.merges ? opts.merges() : Promise.resolve({ sha: 'merge-sha' }); }
        return Promise.resolve(null);
      }) as any);
      return calls;
    }
    const refreshCtx = { requireMergeCommit: true, refreshTrunk: 'dev', refreshTrunkSha: 'dev-at-sync', refreshMissionHeadSha: 'mission-before' };

    beforeEach(() => {
      missionRow.branchRefreshConflictTaskId = 'task-sync';
      tasksById['task-sync'] = { id: 'task-sync', status: 'completed', context: { ...refreshCtx } };
      prWorkerByTaskId['task-sync'] = { prNumber: 4019 };
    });

    it('coalesces a burst of dev merges and duplicate webhooks into the one task while its PR is open', async () => {
      const calls = github({ pr: { state: 'open', merged: false, head: { sha: 'pr-head' } } });
      for (const devSha of ['dev-a', 'dev-b', 'dev-c']) {
        github({ devSha, pr: { state: 'open', merged: false, head: { sha: 'pr-head' } } });
        const outcomes = await Promise.all([refreshMissionIntegrationBranch('m-1'), refreshMissionIntegrationBranch('m-1')]);
        for (const o of outcomes) expect(['conflict_task_open', 'in_flight']).toContain((o as any).reason);
      }
      expect(calls.merges).toBe(0);
      expect(insertedTasks).toHaveLength(0);
      expect(missionRow.branchRefreshConflictTaskId).toBe('task-sync');
    });

    it('a merged PR that provably carried dev clears the task and refreshing resumes', async () => {
      const calls = github({
        pr: { state: 'closed', merged: true, head: { sha: 'pr-head' } },
        compare: { 'dev-at-sync...branch-head': 'ahead', 'mission-before...branch-head': 'ahead' },
      });

      const outcome = await refreshMissionIntegrationBranch('m-1');

      expect(outcome.kind).toBe('merged');
      expect(calls.merges).toBe(1);
      expect(missionRow.branchRefreshConflictTaskId).toBeNull();
      expect(tasksById['task-sync'].context.refreshInvariantViolation).toBeUndefined();
    });

    it('a squashed refresh PR is reported once, never marks the branch caught up, and opens no replacement', async () => {
      missionRow.branchRefreshHeadSha = 'dev-older';
      const squashed = {
        pr: { state: 'closed', merged: true, head: { sha: 'pr-head' } },
        compare: { 'dev-at-sync...branch-head': 'diverged', 'mission-before...branch-head': 'ahead' },
      };
      const calls = github(squashed);

      const outcomes = [];
      for (let i = 0; i < 3; i++) outcomes.push(await refreshMissionIntegrationBranch('m-1'));

      for (const o of outcomes) expect(o).toMatchObject({ kind: 'skipped', reason: 'refresh_unverified', conflictTaskId: 'task-sync' });
      expect((outcomes[0] as any).detail).toContain('does not contain dev dev-at-');
      expect(calls.merges).toBe(0);
      expect(insertedTasks).toHaveLength(0);
      expect(missionRow.branchRefreshConflictTaskId).toBe('task-sync');
      expect(missionRow.branchRefreshHeadSha).toBe('dev-older');
      // Visible exactly once: task context, gate ledger, mission feed.
      expect(tasksById['task-sync'].context.refreshInvariantViolation).toMatchObject({ prNumber: 4019, branchHead: 'branch-head' });
      expect(gateEvents.filter(e => e.detail?.invariant === 'refresh_ancestry')).toHaveLength(1);
      const violationNotes = insertedNotes.filter(n => n.title === 'Integration branch refresh did not land');
      expect(violationNotes).toHaveLength(1);
      expect(violationNotes[0].body).toContain('Never force-push');

      // A later repair lands a real merge: the same check passes and refreshing resumes.
      const repaired = github({ ...squashed, branchHead: 'repair-head', compare: { 'dev-at-sync...repair-head': 'ahead', 'mission-before...repair-head': 'ahead' } });
      const after = await refreshMissionIntegrationBranch('m-1');
      expect(after.kind).toBe('merged');
      expect(repaired.merges).toBe(1);
      expect(missionRow.branchRefreshConflictTaskId).toBeNull();
    });

    it('a failed GitHub read keeps the task open rather than guessing either way', async () => {
      github({ pr: { state: 'closed', merged: true, head: { sha: 'pr-head' } }, compare: {} });
      const outcome = await refreshMissionIntegrationBranch('m-1');
      expect(outcome).toMatchObject({ kind: 'skipped', reason: 'conflict_task_open' });
      expect(gateEvents).toHaveLength(0);

      github({ pr: githubError(502, 'bad gateway') });
      expect(await refreshMissionIntegrationBranch('m-1')).toMatchObject({ kind: 'skipped', reason: 'conflict_task_open' });
      expect(missionRow.branchRefreshConflictTaskId).toBe('task-sync');
    });

    it('a PR closed without merging frees the slot, and a still-conflicting branch gets exactly one new task', async () => {
      const calls = github({
        pr: { state: 'closed', merged: false, head: { sha: 'pr-head' } },
        merges: () => Promise.reject(githubError(409, 'conflict')),
      });

      const first = await refreshMissionIntegrationBranch('m-1');
      const second = await refreshMissionIntegrationBranch('m-1');

      expect(first.kind).toBe('conflict');
      expect(second).toMatchObject({ kind: 'skipped', reason: 'conflict_task_open' });
      expect(insertedTasks).toHaveLength(1);
      expect(calls.merges).toBe(1);
    });
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
    mockTaskInsert.mockReset();
    mockTaskInsert.mockResolvedValue(undefined);
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
