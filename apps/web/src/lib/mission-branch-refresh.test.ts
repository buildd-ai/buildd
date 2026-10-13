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
/** missionId → it has a non-terminal task (the backstop's activity test). */
let liveWorkByMission: Record<string, boolean> = {};
/** taskId → it has a non-terminal retry (a task whose parentTaskId is it). */
let liveRetryByTask: Record<string, boolean> = {};
const insertedNotes: any[] = [];
const insertedTasks: any[] = [];
const mockTaskInsert = mock(() => Promise.resolve());

function resetFixtures() {
  missionRow = {
    id: 'm-1',
    title: 'Example Mission',
    status: 'active',
    isHeld: false,
    workspaceId: 'ws-1',
    workingBranch: 'mission/example-slug-0a1b2c3d',
    integrationBranchEnabled: true,
    branchRefreshHeadSha: null,
    branchRefreshLeaseUntil: null,
    branchRefreshConflictTaskId: null,
    branchRefreshedAt: null,
  };
  tasksById = {};
  prWorkerByTaskId = {};
  liveWorkByMission = {};
  liveRetryByTask = {};
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
          const byMission = args?.where?.op === 'and' ? args.where.args[0] : null;
          if (byMission?.op === 'eq' && byMission.args?.[0] === 'missionId') {
            return Promise.resolve(liveWorkByMission[byMission.args[1]] ? { id: 'live-task' } : null);
          }
          if (byMission?.op === 'eq' && byMission.args?.[0] === 'parentTaskId') {
            return Promise.resolve(liveRetryByTask[byMission.args[1]] ? { id: 'live-retry' } : null);
          }
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
  if (p == null) return true;
  if ('isNull' in p) return missionRow[p.isNull] == null;
  if (p.op === 'notInArray') return !p.args[1].includes(missionRow[p.args[0]]);
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
      if (Object.prototype.hasOwnProperty.call(setVals, 'branchRefreshedAt')) {
        missionRow.branchRefreshedAt = setVals.branchRefreshedAt;
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
      if (String(table) === 'tasks') {
        const id = v.id ?? `task-${nextTaskId++}`;
        const row = { id, status: 'pending', ...v };
        return {
          onConflictDoNothing: () => ({ returning: async () => {
            await mockTaskInsert();
            if (tasksById[id]) return []; // the primary key already exists
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
  missions: Object.assign(new String('missions'), Object.fromEntries(['id', 'status', 'isHeld', 'branchRefreshLeaseUntil', 'branchRefreshLeaseToken', 'branchRefreshConflictTaskId'].map(k => [k, k]))),
  missionNotes: 'missionNotes',
  tasks: Object.assign(new String('tasks'), { id: 'id', missionId: 'missionId', status: 'status', parentTaskId: 'parentTaskId' }),
  workers: { taskId: 'taskId', prNumber: 'prNumber', createdAt: 'createdAt' },
  workspaces: 'workspaces',
  githubRepos: 'githubRepos',
}));

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ op: 'eq', args }),
  and: (...args: any[]) => ({ op: 'and', args }),
  inArray: (...args: any[]) => args,
  notInArray: (...args: any[]) => ({ op: 'notInArray', args }),
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

// The kernel's delivery row for the mission PR: a merge it recorded counts as
// shipped even when the owner worker row never got its mergedAt.
const mockDeliveryPrStates = mock((_ws: string, _prs: number[]) => Promise.resolve([] as Array<{ prNumber: number; state: string; mergedAt: string | null }>));
mock.module('@/lib/workflow/delivery-view', () => ({
  deliveryPrStates: (...args: any[]) => mockDeliveryPrStates(...(args as [string, number[]])),
}));

mock.module('@/lib/repo-scope', () => ({
  workspaceRepoMatches: (...args: any[]) => mockWorkspaceRepoMatches(...args),
}));

const {
  refreshMissionIntegrationBranch,
  sweepMissionBranchRefresh,
  refreshMissionBranchesBeforeStart,
  BRANCH_REFRESH_BACKSTOP_MS,
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

  it('a reservation whose insert outlives the lease yields one task: the successor finishes it under the same id', async () => {
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
    const reserved = missionRow.branchRefreshConflictTaskId;
    missionRow.branchRefreshLeaseUntil = new Date(Date.now() - 1);
    expect(await refreshMissionIntegrationBranch('m-1')).toEqual({ kind: 'conflict', conflictTaskId: reserved, dispatched: true });
    resume.resolve();
    // The slow original finds its id already written: not a second task, not an error.
    expect(await first).toEqual({ kind: 'conflict', conflictTaskId: reserved, dispatched: false });
    expect(insertedTasks).toHaveLength(1);
    expect(insertedTasks[0].id).toBe(reserved);
    expect(missionRow.branchRefreshConflictTaskId).toBe(reserved);
    expect(merges).toBe(1);
  });

  it('a caller that died between reserving and inserting does not stop refreshing for good', async () => {
    // The crash: the pointer names an id with no row, and the lease was never released.
    missionRow.branchRefreshConflictTaskId = 'reserved-by-dead-caller';
    missionRow.branchRefreshLeaseUntil = new Date(Date.now() - 1);
    missionRow.branchRefreshLeaseToken = 'dead-token';
    let merges = 0;
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/merges')) { merges++; return Promise.reject(githubError(409, 'conflict')); }
      return Promise.resolve({ object: { sha: 'dev-new' } });
    }) as any);

    const outcome = await refreshMissionIntegrationBranch('m-1');

    expect(outcome).toEqual({ kind: 'conflict', conflictTaskId: 'reserved-by-dead-caller', dispatched: true });
    expect(insertedTasks).toHaveLength(1);
    expect(insertedTasks[0].context).toMatchObject({ requireMergeCommit: true, refreshTrunkSha: 'dev-new' });
    // The reservation is evidence of the 409: finishing it makes no second merge attempt.
    expect(merges).toBe(0);
    expect(missionRow.branchRefreshLeaseUntil).toBeNull();
    expect(await refreshMissionIntegrationBranch('m-1')).toMatchObject({ kind: 'skipped', reason: 'conflict_task_open' });
    expect(insertedTasks).toHaveLength(1);
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
    // Generated files are regenerated by the resolver, not merged by hand.
    expect(insertedTasks[0].description).toContain('bun run conflicts:generated');
    // A migration moves only through the tools, whose byte-identical renumber
    // the merge-safety inspector reads as a renumber, not lineage (task 87c7e48d).
    expect(insertedTasks[0].description).toContain('bun run migrations:regenerate --base=origin/dev');
    expect(insertedTasks[0].description).not.toContain('bun db:generate` so this branch');
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

  // The incident behind #4686: the shipping PR merged, but its owner worker row
  // never got mergedAt (a lossy webhook), so every later trigger merged trunk
  // into a branch nothing would land again and, on a conflict, filed a task.
  describe('the shipping PR merged but the owner worker row has no mergedAt', () => {
    const openOwner = { state: 'open', prNumber: 4686, prUrl: 'https://github.com/buildd-ai/buildd/pull/4686', workerId: 'w', taskId: 't', mergedAt: null };
    const githubWith = (prMerged: () => boolean) => {
      const calls = { merges: 0, prReads: 0 };
      mockGithubApi.mockImplementation(((_i: number, path: string, opts?: any) => {
        if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
        if (path.endsWith('/merges') && opts?.method === 'POST') { calls.merges++; return Promise.reject(githubError(409, 'conflict')); }
        if (path.endsWith('/pulls/4686')) { calls.prReads++; return Promise.resolve({ number: 4686, merged: prMerged(), state: prMerged() ? 'closed' : 'open' }); }
        return Promise.resolve(null);
      }) as any);
      return calls;
    };

    beforeEach(() => {
      mockDeliveryPrStates.mockReset();
      mockDeliveryPrStates.mockResolvedValue([]);
      mockFindMissionPrOwner.mockResolvedValue(openOwner);
    });

    it('the kernel delivery says MERGED: no merge call, no refresh task', async () => {
      mockDeliveryPrStates.mockResolvedValue([{ prNumber: 4686, state: 'MERGED', mergedAt: '2026-10-12T00:00:00.000Z' }]);
      const calls = githubWith(() => false);

      expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'start' })).toEqual({ kind: 'skipped', reason: 'mission_pr_merged' });
      expect(calls.merges).toBe(0);
      expect(insertedTasks).toHaveLength(0);
    });

    it('GitHub says merged (no kernel row): no merge call, no refresh task', async () => {
      const calls = githubWith(() => true);

      expect(await refreshMissionIntegrationBranch('m-1')).toEqual({ kind: 'skipped', reason: 'mission_pr_merged' });
      expect(calls.merges).toBe(0);
      expect(insertedTasks).toHaveLength(0);
    });

    it('a still-open PR refreshes as before', async () => {
      const calls = githubWith(() => false);

      expect((await refreshMissionIntegrationBranch('m-1')).kind).toBe('conflict');
      expect(calls.merges).toBe(1);
      expect(insertedTasks).toHaveLength(1);
    });

    it('the reserved path re-checks right before dispatch', async () => {
      // A dispatch reserved the pointer and died before inserting the row.
      missionRow.branchRefreshConflictTaskId = 'reserved-task';
      let reads = 0;
      // Not merged at entry; merged by the time the reservation is finished.
      const calls = githubWith(() => ++reads > 1);

      expect(await refreshMissionIntegrationBranch('m-1')).toEqual({ kind: 'skipped', reason: 'mission_pr_merged' });
      expect(calls.prReads).toBe(2);
      expect(insertedTasks).toHaveLength(0);
      expect(calls.merges).toBe(0);
    });
  });
});

describe('the last confirmed refresh is timestamped', () => {
  beforeEach(() => {
    resetFixtures();
    mockGithubApi.mockReset();
    mockEnsureMissionIntegrationBranch.mockReset();
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: missionRow.workingBranch, created: false });
    mockFindMissionPrOwner.mockReset();
    mockFindMissionPrOwner.mockResolvedValue(null);
  });

  const withMerge = (answer: unknown) => mockGithubApi.mockImplementation(((_i: number, path: string, opts?: any) => {
    if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
    if (path.endsWith('/merges') && opts?.method === 'POST') return Promise.resolve(answer);
    return Promise.resolve(null);
  }) as any);

  it('on a clean merge', async () => {
    withMerge({ sha: 'merge-commit-sha' });
    await refreshMissionIntegrationBranch('m-1');
    expect(missionRow.branchRefreshedAt).toBeInstanceOf(Date);
  });

  it('on a 204 (the branch already contained trunk)', async () => {
    withMerge(null);
    await refreshMissionIntegrationBranch('m-1');
    expect(missionRow.branchRefreshedAt).toBeInstanceOf(Date);
  });

  it('on a freshly cut branch', async () => {
    withMerge(null);
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: missionRow.workingBranch, created: true });
    await refreshMissionIntegrationBranch('m-1');
    expect(missionRow.branchRefreshedAt).toBeInstanceOf(Date);
  });

  it('never on a conflict: the branch is not current', async () => {
    mockGithubApi.mockImplementation(((_i: number, path: string, opts?: any) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
      if (path.endsWith('/merges') && opts?.method === 'POST') return Promise.reject(githubError(409, { message: 'Merge conflict' }));
      return Promise.resolve(null);
    }) as any);
    await refreshMissionIntegrationBranch('m-1');
    expect(missionRow.branchRefreshedAt).toBeNull();
  });
});

describe('sweepMissionBranchRefresh (the daily backstop)', () => {
  beforeEach(() => {
    resetFixtures();
    mockTaskInsert.mockReset();
    mockTaskInsert.mockResolvedValue(undefined);
    mockMissionsFindMany.mockReset();
    mockFindMissionPrOwner.mockReset();
    mockFindMissionPrOwner.mockResolvedValue(null);
    mockEnsureMissionIntegrationBranch.mockReset();
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: missionRow.workingBranch, created: false });
    mockGithubApi.mockReset();
    mockGithubApi.mockImplementation(((_i: number, path: string, opts?: any) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
      if (path.endsWith('/merges') && opts?.method === 'POST') return Promise.resolve({ sha: 'merge-commit-sha' });
      return Promise.resolve(null);
    }) as any);
  });

  const merges = () => mockGithubApi.mock.calls.filter(c => String(c[1]).endsWith('/merges')).length;
  const candidate = (refreshedAt: Date | null) => [{ id: 'm-1', branchRefreshedAt: refreshedAt }];

  it('refreshes a stale mission that still has live work', async () => {
    mockMissionsFindMany.mockResolvedValue(candidate(new Date(Date.now() - BRANCH_REFRESH_BACKSTOP_MS - 60_000)));
    liveWorkByMission['m-1'] = true;
    const result = await sweepMissionBranchRefresh();
    expect(result).toMatchObject({ scanned: 1, merged: 1 });
    expect(merges()).toBe(1);
  });

  it('refreshes a never-refreshed mission (null reads as stale)', async () => {
    mockMissionsFindMany.mockResolvedValue(candidate(null));
    liveWorkByMission['m-1'] = true;
    expect((await sweepMissionBranchRefresh()).merged).toBe(1);
  });

  it('leaves a mission refreshed within the window alone, with no GitHub call', async () => {
    mockMissionsFindMany.mockResolvedValue(candidate(new Date(Date.now() - 60_000)));
    liveWorkByMission['m-1'] = true;
    const result = await sweepMissionBranchRefresh();
    expect(result).toMatchObject({ scanned: 1, skipped: 1, merged: 0 });
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('leaves an idle mission alone: no live task and no open mission PR', async () => {
    mockMissionsFindMany.mockResolvedValue(candidate(null));
    const result = await sweepMissionBranchRefresh();
    expect(result).toMatchObject({ scanned: 1, skipped: 1, merged: 0 });
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('counts an open mission PR as live work', async () => {
    mockMissionsFindMany.mockResolvedValue(candidate(null));
    mockFindMissionPrOwner.mockResolvedValue({ state: 'open' });
    expect((await sweepMissionBranchRefresh()).merged).toBe(1);
  });

  it('is a no-op when nothing is eligible', async () => {
    mockMissionsFindMany.mockResolvedValue([]);
    expect(await sweepMissionBranchRefresh()).toEqual({ scanned: 0, merged: 0, conflicts: 0, skipped: 0, errors: 0 });
  });
});

describe('refreshMissionBranchesBeforeStart (a mission task is starting)', () => {
  const BRANCH = 'mission/example-slug-0a1b2c3d';
  beforeEach(() => {
    resetFixtures();
    mockMissionsFindMany.mockReset();
    mockMissionsFindMany.mockResolvedValue([{ id: 'm-1', workingBranch: BRANCH, integrationBranchEnabled: true }]);
    mockFindMissionPrOwner.mockReset();
    mockFindMissionPrOwner.mockResolvedValue(null);
    mockEnsureMissionIntegrationBranch.mockReset();
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: BRANCH, created: false });
    mockGithubApi.mockReset();
    mockGithubApi.mockImplementation(((_i: number, path: string, opts?: any) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-sha-current' } });
      if (path.endsWith('/merges') && opts?.method === 'POST') return Promise.resolve({ sha: 'merge-commit-sha' });
      return Promise.resolve(null);
    }) as any);
  });

  const merges = () => mockGithubApi.mock.calls.filter(c => String(c[1]).endsWith('/merges')).length;
  const task = (context: Record<string, unknown>, missionId: string | null = 'm-1') => ({ missionId, context });

  it('merges trunk into the branch a mission work task is about to cut from', async () => {
    const out = await refreshMissionBranchesBeforeStart([task({ baseBranch: BRANCH })]);
    expect(merges()).toBe(1);
    expect(out).toEqual({ 'm-1': { kind: 'merged', headSha: 'dev-sha-current' } });
  });

  it('refreshes a mission once however many of its tasks start together', async () => {
    await refreshMissionBranchesBeforeStart([task({ baseBranch: BRANCH }), task({ baseBranch: BRANCH }), task({ baseBranch: BRANCH })]);
    expect(merges()).toBe(1);
  });

  it('ignores a task based on anything other than its mission branch (a fix or CI-fix retry)', async () => {
    const out = await refreshMissionBranchesBeforeStart([task({ baseBranch: 'buildd/0a1b2c3d-fix-something' }), task({})]);
    expect(out).toEqual({});
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('ignores the refresh conflict task itself', async () => {
    const out = await refreshMissionBranchesBeforeStart([task({ baseBranch: BRANCH, requireMergeCommit: true })]);
    expect(out).toEqual({});
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('ignores a task with no mission, and a mission not using an integration branch', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'm-1', workingBranch: BRANCH, integrationBranchEnabled: false }]);
    const out = await refreshMissionBranchesBeforeStart([task({ baseBranch: BRANCH }, null), task({ baseBranch: BRANCH })]);
    expect(out).toEqual({});
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('never holds the claim past its budget: a slow refresh is left to finish on its own', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockGithubApi.mockImplementation((async (_i: number, path: string) => {
      await gate;
      if (path.endsWith('/git/ref/heads/dev')) return { object: { sha: 'dev-sha-current' } };
      return null;
    }) as any);
    const started = Date.now();
    const out = await refreshMissionBranchesBeforeStart([task({ baseBranch: BRANCH })], { budgetMs: 30 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toEqual({ 'm-1': 'timed_out' });
    release();
  });

  it('fails open: a refresh that throws never fails the claim', async () => {
    mockMissionsFindMany.mockRejectedValue(new Error('db down'));
    expect(await refreshMissionBranchesBeforeStart([task({ baseBranch: BRANCH })])).toEqual({});
  });
});

// ── Cross-operation interleavings (docs/specs/mission-branch-refresh.md, "Lifecycle and concurrency") ──

describe('interleavings: mission state, unknown outcomes, and request termination', () => {
  const BRANCH = 'mission/example-slug-0a1b2c3d';
  beforeEach(() => {
    resetFixtures();
    mockTaskInsert.mockReset();
    mockTaskInsert.mockResolvedValue(undefined);
    mockMissionsFindMany.mockReset();
    mockFindMissionPrOwner.mockReset();
    mockFindMissionPrOwner.mockResolvedValue(null);
    mockEnsureMissionIntegrationBranch.mockReset();
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: BRANCH, created: false });
    mockAnnounceTaskCreated.mockReset();
    mockAnnounceTaskCreated.mockResolvedValue(undefined);
    mockWakeTask.mockReset();
    mockWakeTask.mockResolvedValue(undefined);
    mockGithubApi.mockReset();
    gateEvents.length = 0;
  });

  /** Fake GitHub: dev's head, and a merges answer (counted). */
  function github(merge: () => Promise<any>, devSha = 'dev-new') {
    const calls = { merges: 0 };
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/merges')) { calls.merges++; return merge(); }
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: devSha } });
      return Promise.resolve(null);
    }) as any);
    return calls;
  }

  it('a mission completed while the refresh is in flight gets no merge, and the lease is released', async () => {
    const entered = deferred<void>();
    const resume = deferred<any>();
    mockEnsureMissionIntegrationBranch.mockImplementationOnce(() => { entered.resolve(); return resume.promise; });
    const calls = github(() => Promise.resolve({ sha: 'merge-sha' }));

    const inFlight = refreshMissionIntegrationBranch('m-1', { trigger: 'start' });
    await entered.promise;
    missionRow.status = 'completed';
    resume.resolve({ ok: true, created: false, branch: BRANCH });

    expect(await inFlight).toEqual({ kind: 'skipped', reason: 'mission_terminal', detail: 'completed' });
    expect(calls.merges).toBe(0);
    expect(missionRow.branchRefreshHeadSha).toBeNull();
    expect(missionRow.branchRefreshLeaseUntil).toBeNull();
  });

  it('a mission archived between a 409 and the conflict dispatch gets no conflict task', async () => {
    const calls = github(() => {
      missionRow.status = 'archived';
      return Promise.reject(githubError(409, 'conflict'));
    });

    const outcome = await refreshMissionIntegrationBranch('m-1', { trigger: 'start' });

    expect(outcome).toEqual({ kind: 'skipped', reason: 'mission_terminal', detail: 'archived' });
    expect(calls.merges).toBe(1);
    expect(insertedTasks).toHaveLength(0);
    expect(missionRow.branchRefreshConflictTaskId).toBeNull();
  });

  it('the mission PR merging while the refresh is in flight stops the write', async () => {
    const entered = deferred<void>();
    const resume = deferred<any>();
    mockEnsureMissionIntegrationBranch.mockImplementationOnce(() => { entered.resolve(); return resume.promise; });
    const calls = github(() => Promise.resolve({ sha: 'merge-sha' }));

    const inFlight = refreshMissionIntegrationBranch('m-1', { trigger: 'start' });
    await entered.promise;
    mockFindMissionPrOwner.mockResolvedValue({ state: 'merged' });
    resume.resolve({ ok: true, created: false, branch: BRANCH });

    expect(await inFlight).toEqual({ kind: 'skipped', reason: 'mission_pr_merged' });
    expect(calls.merges).toBe(0);
  });

  it('a backstop refresh never writes to a paused or held mission; pausing mid-flight stops it', async () => {
    const calls = github(() => Promise.resolve({ sha: 'merge-sha' }));
    missionRow.status = 'paused';
    expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'backstop' })).toMatchObject({ kind: 'skipped', reason: 'mission_paused' });
    missionRow.status = 'budget_exhausted';
    expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'backstop' })).toMatchObject({ kind: 'skipped', reason: 'mission_paused' });
    missionRow.status = 'active';
    missionRow.isHeld = true;
    expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'backstop' })).toMatchObject({ kind: 'skipped', reason: 'mission_paused' });
    missionRow.isHeld = false;

    const entered = deferred<void>();
    const resume = deferred<any>();
    mockEnsureMissionIntegrationBranch.mockImplementationOnce(() => { entered.resolve(); return resume.promise; });
    const inFlight = refreshMissionIntegrationBranch('m-1', { trigger: 'backstop' });
    await entered.promise;
    missionRow.status = 'paused';
    resume.resolve({ ok: true, created: false, branch: BRANCH });
    expect(await inFlight).toMatchObject({ kind: 'skipped', reason: 'mission_paused' });
    expect(calls.merges).toBe(0);
  });

  it('an authorized start refreshes a paused or held mission: the start is the resume', async () => {
    const calls = github(() => Promise.resolve({ sha: 'merge-sha' }));
    missionRow.status = 'paused';
    missionRow.isHeld = true;
    expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'start' })).toEqual({ kind: 'merged', headSha: 'dev-new' });
    expect(calls.merges).toBe(1);
  });

  it('an unknown merges outcome is retried idempotently: GitHub answers 204 and nothing is duplicated', async () => {
    // The merge landed but the answer was lost (a 502 after the write).
    let landed = false;
    const calls = github(() => {
      if (!landed) { landed = true; return Promise.reject(githubError(502, 'bad gateway')); }
      return Promise.resolve(null); // 204: the branch already contains dev
    });

    const first = await refreshMissionIntegrationBranch('m-1', { trigger: 'start' });
    expect(first.kind).toBe('error');
    expect(missionRow.branchRefreshHeadSha).toBeNull(); // nothing confirmed, nothing claimed
    expect(missionRow.branchRefreshedAt).toBeNull();

    const retry = await refreshMissionIntegrationBranch('m-1', { trigger: 'backstop' });
    expect(retry).toEqual({ kind: 'skipped', reason: 'already_current' });
    expect(missionRow.branchRefreshHeadSha).toBe('dev-new');
    expect(calls.merges).toBe(2);
    expect(insertedTasks).toHaveLength(0);
  });

  it('a failed conflict task whose retry is still running keeps the pointer: no second conflict task', async () => {
    missionRow.branchRefreshConflictTaskId = 'task-failed';
    tasksById['task-failed'] = { id: 'task-failed', status: 'failed', context: { requireMergeCommit: true } };
    liveRetryByTask['task-failed'] = true;
    const calls = github(() => Promise.reject(githubError(409, 'conflict')));

    const outcome = await refreshMissionIntegrationBranch('m-1', { trigger: 'start' });

    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'conflict_task_open', conflictTaskId: 'task-failed' });
    expect(calls.merges).toBe(0);
    expect(insertedTasks).toHaveLength(0);

    // The retry ends too: the repair is over, and the next refresh may try again.
    liveRetryByTask['task-failed'] = false;
    expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'start' })).toMatchObject({ kind: 'conflict', dispatched: true });
    expect(insertedTasks).toHaveLength(1);
  });

  it('claim timeout, then request termination: the start hands off, and the sweep finishes it after the lease expires', async () => {
    // The refresh outlives the budget and the request is torn down mid-call:
    // the GitHub read never answers, so the lease is never released.
    mockMissionsFindMany.mockResolvedValue([{ id: 'm-1', workingBranch: BRANCH, integrationBranchEnabled: true }]);
    mockGithubApi.mockImplementation((() => new Promise(() => {})) as any);
    const keptAlive: Promise<unknown>[] = [];

    const out = await refreshMissionBranchesBeforeStart(
      [{ missionId: 'm-1', context: { baseBranch: BRANCH } }],
      { budgetMs: 20, keepAlive: (p) => keptAlive.push(p) },
    );
    expect(out).toEqual({ 'm-1': 'timed_out' });
    expect(keptAlive).toHaveLength(1);
    expect(missionRow.branchRefreshLeaseUntil).toBeInstanceOf(Date);

    // A second start inside the lease coalesces into it (no second writer).
    expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'start' })).toMatchObject({ kind: 'skipped', reason: 'in_flight' });

    // The lease expires. The branch was refreshed recently, so only the
    // abandoned lease makes the mission due.
    missionRow.branchRefreshLeaseUntil = new Date(Date.now() - 1);
    missionRow.branchRefreshedAt = new Date(Date.now() - 60_000);
    liveWorkByMission['m-1'] = true;
    mockMissionsFindMany.mockResolvedValue([{
      id: 'm-1', branchRefreshedAt: missionRow.branchRefreshedAt,
      branchRefreshLeaseUntil: missionRow.branchRefreshLeaseUntil, branchRefreshConflictTaskId: null,
    }]);
    const calls = github(() => Promise.resolve({ sha: 'merge-sha' }));

    expect(await sweepMissionBranchRefresh()).toMatchObject({ scanned: 1, merged: 1 });
    expect(calls.merges).toBe(1);
    expect(missionRow.branchRefreshHeadSha).toBe('dev-new');
    expect(missionRow.branchRefreshLeaseUntil).toBeNull();
  });

  it('the sweep settles a conflict pointer within the hour, not a day', async () => {
    missionRow.branchRefreshConflictTaskId = 'task-sync';
    missionRow.branchRefreshedAt = new Date(Date.now() - 60_000);
    tasksById['task-sync'] = { id: 'task-sync', status: 'completed', context: { requireMergeCommit: true, refreshTrunk: 'dev', refreshTrunkSha: 'dev-at-sync', refreshMissionHeadSha: 'mission-before' } };
    prWorkerByTaskId['task-sync'] = { prNumber: 4019 };
    liveWorkByMission['m-1'] = true;
    mockMissionsFindMany.mockResolvedValue([{
      id: 'm-1', branchRefreshedAt: missionRow.branchRefreshedAt, branchRefreshLeaseUntil: null, branchRefreshConflictTaskId: 'task-sync',
    }]);
    let merges = 0;
    mockGithubApi.mockImplementation(((_i: number, path: string) => {
      if (path.endsWith('/git/ref/heads/dev')) return Promise.resolve({ object: { sha: 'dev-new' } });
      if (path.endsWith(`/git/ref/heads/${BRANCH}`)) return Promise.resolve({ object: { sha: 'branch-head' } });
      if (/\/pulls\/\d+$/.test(path)) return Promise.resolve({ state: 'closed', merged: true, head: { sha: 'pr-head' } });
      if (path.includes('/compare/')) return Promise.resolve({ status: 'ahead' });
      if (path.endsWith('/merges')) { merges++; return Promise.resolve(null); }
      return Promise.resolve(null);
    }) as any);

    expect(await sweepMissionBranchRefresh()).toMatchObject({ scanned: 1 });
    expect(missionRow.branchRefreshConflictTaskId).toBeNull();
    expect(merges).toBe(1);
  });

  it('the sweep leaves a mission inside its window alone when nothing is unfinished', async () => {
    mockMissionsFindMany.mockResolvedValue([{
      id: 'm-1', branchRefreshedAt: new Date(Date.now() - 60_000), branchRefreshLeaseUntil: null, branchRefreshConflictTaskId: null,
    }]);
    liveWorkByMission['m-1'] = true;
    expect(await sweepMissionBranchRefresh()).toMatchObject({ scanned: 1, skipped: 1 });
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('the sweep asks the database only for missions it may write to: not paused, held, exhausted or terminal', async () => {
    mockMissionsFindMany.mockResolvedValue([]);
    await sweepMissionBranchRefresh();
    const where = JSON.stringify((mockMissionsFindMany.mock.calls[0] as any[])[0].where);
    for (const s of ['completed', 'archived', 'paused', 'budget_exhausted']) expect(where).toContain(s);
    expect(where).toContain('isHeld');
  });
});

// ── Real Git: ancestry and lost-commit claims a mocked GitHub cannot prove ──
//
// A local repository stands in for GitHub. Each GitHub call is one atomic
// operation on it, built from git plumbing the way GitHub performs it: the
// merges API is `merge-tree` + a two-parent commit, a PR landing is pinned to
// the head it was approved at (`sha`), and every ref write is a compare-and-swap
// (`update-ref <ref> <new> <old>`). Interleavings are orderings of those calls,
// which is exactly the granularity GitHub gives concurrent writers.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMergeMethod, verifyRefreshLanded } from './integration-refresh';

function gitHubOverGit() {
  const dir = mkdtempSync(join(tmpdir(), 'mission-refresh-git-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (args: string[], extra: Record<string, string> = {}, input?: string) =>
    execFileSync('git', args, { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const ok = (args: string[]) => { try { git(args); return true; } catch { return false; } };
  git(['init', '-q', '--bare']);

  const head = (branch: string): string | null => { try { return git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]); } catch { return null; } };
  const isAncestor = (a: string, b: string) => ok(['merge-base', '--is-ancestor', a, b]);
  /** A tree: `base`'s tree (if any) with `files` written over it. */
  const tree = (base: string | null, files: Record<string, string>): string => {
    const index = join(dir, `index-${Math.random().toString(36).slice(2)}`);
    const e = { GIT_INDEX_FILE: index };
    if (base) git(['read-tree', base], e); else git(['read-tree', '--empty'], e);
    for (const [path, content] of Object.entries(files)) {
      const blob = git(['hash-object', '-w', '--stdin'], {}, content);
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], e);
    }
    const t = git(['write-tree'], e);
    rmSync(index, { force: true });
    return t;
  };
  const commitTree = (t: string, parents: string[], msg: string) =>
    git(['commit-tree', t, ...parents.flatMap(p => ['-p', p]), '-m', msg]);
  /** Compare-and-swap, as GitHub's ref writes are. */
  const cas = (branch: string, next: string, prev: string | null): boolean =>
    ok(['update-ref', `refs/heads/${branch}`, next, prev ?? '0000000000000000000000000000000000000000']);

  const gh = {
    dir,
    head,
    isAncestor,
    read: (ref: string, path: string): string | null => { try { return git(['show', `${ref}:${path}`]); } catch { return null; } },
    commit(branch: string, files: Record<string, string>, msg = `edit ${Object.keys(files).join(',')}`): string {
      const prev = head(branch);
      const sha = commitTree(tree(prev, files), prev ? [prev] : [], msg);
      if (!cas(branch, sha, prev)) throw new Error(`ref ${branch} moved`);
      return sha;
    },
    branch(name: string, from: string) { if (!cas(name, head(from)!, null)) throw new Error(`${name} exists`); },
    /** `POST /merges`: 201 with a merge commit, 204 (null) when already contained, 409 on a conflict. */
    mergesApi(base: string, from: string): { sha: string } | null {
      const b = head(base)!; const h = head(from)!;
      if (isAncestor(h, b)) return null;
      let t: string;
      try { t = git(['merge-tree', '--write-tree', b, h]).split('\n')[0]; } catch { throw githubError(409, { message: 'Merge conflict' }); }
      const sha = commitTree(t, [b, h], `Merge ${from} into ${base}`);
      if (!cas(base, sha, b)) throw githubError(409, { message: 'Base moved' });
      return { sha };
    },
    /** `PUT /pulls/:n/merge` pinned to `expectedHeadSha`, with the method the door chose. */
    landPr(p: { base: string; headBranch: string; expectedHeadSha: string; method: 'merge' | 'squash' }): { merged: boolean; status?: number; sha?: string } {
      const h = head(p.headBranch);
      if (h !== p.expectedHeadSha) return { merged: false, status: 409 }; // "Head branch was modified"
      const b = head(p.base)!;
      let t: string;
      try { t = git(['merge-tree', '--write-tree', b, h]).split('\n')[0]; } catch { return { merged: false, status: 405 }; }
      const sha = commitTree(t, p.method === 'merge' ? [b, h] : [b], `land ${p.headBranch}`);
      return cas(p.base, sha, b) ? { merged: true, sha } : { merged: false, status: 409 };
    },
    /** An agent's conflict resolution: `git merge origin/<from>` on a branch cut from `onto`, conflicts settled by `resolved`. */
    resolveMerge(branchName: string, onto: string, from: string, resolved: Record<string, string>): string {
      const o = head(onto)!; const f = head(from)!;
      let t: string;
      try { t = git(['merge-tree', '--write-tree', o, f]).split('\n')[0]; } catch (e: any) { t = String(e.stdout).split('\n')[0]; }
      const sha = commitTree(tree(t, resolved), [o, f], `Merge ${from} into ${branchName}`);
      if (!cas(branchName, sha, null)) throw new Error(`${branchName} exists`);
      return sha;
    },
    compare(a: string, b: string) {
      const sa = git(['rev-parse', a]); const sb = git(['rev-parse', b]);
      const status = sa === sb ? 'identical' : isAncestor(sa, sb) ? 'ahead' : isAncestor(sb, sa) ? 'behind' : 'diverged';
      return { status, merge_base_commit: { sha: git(['merge-base', sa, sb]) } };
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
  return gh;
}

describe('real Git: refresh, task landings, the repair and the mission PR interleave without losing a commit', () => {
  const BRANCH = 'mission/example-slug-0a1b2c3d';
  let gh: ReturnType<typeof gitHubOverGit>;
  let prs: Record<number, { state: string; merged: boolean; head: { sha: string } }>;
  let mergesCalls = 0;

  beforeEach(() => {
    resetFixtures();
    gh?.dispose();
    gh = gitHubOverGit();
    prs = {};
    mergesCalls = 0;
    mockTaskInsert.mockReset();
    mockTaskInsert.mockResolvedValue(undefined);
    mockFindMissionPrOwner.mockReset();
    mockFindMissionPrOwner.mockResolvedValue(null);
    mockEnsureMissionIntegrationBranch.mockReset();
    mockEnsureMissionIntegrationBranch.mockResolvedValue({ ok: true, branch: BRANCH, created: false });
    mockAnnounceTaskCreated.mockReset();
    mockAnnounceTaskCreated.mockResolvedValue(undefined);
    mockWakeTask.mockReset();
    mockWakeTask.mockResolvedValue(undefined);
    gateEvents.length = 0;
    mockGithubApi.mockReset();
    mockGithubApi.mockImplementation((async (_i: number, path: string, opts?: any) => {
      const ref = /\/git\/ref\/heads\/(.+)$/.exec(path);
      if (ref) {
        const sha = gh.head(ref[1].split('/').map(decodeURIComponent).join('/'));
        if (!sha) throw githubError(404, 'Not Found');
        return { object: { sha } };
      }
      if (path.endsWith('/merges') && opts?.method === 'POST') {
        mergesCalls++;
        const body = JSON.parse(opts.body);
        return gh.mergesApi(body.base, body.head);
      }
      const cmp = /\/compare\/(.+)\.\.\.(.+)$/.exec(path);
      if (cmp) return gh.compare(decodeURIComponent(cmp[1]), decodeURIComponent(cmp[2]));
      const pr = /\/pulls\/(\d+)$/.exec(path);
      if (pr) return prs[Number(pr[1])] ?? null;
      return null;
    }) as any);

    // dev and the mission diverge on one file; each also adds its own.
    gh.commit('dev', { 'shared.ts': 'v0\n', 'README.md': 'base\n' }, 'base');
    gh.branch(BRANCH, 'dev');
    gh.commit(BRANCH, { 'shared.ts': 'mission\n', 'mission.ts': 'mission work\n' });
    gh.commit('dev', { 'shared.ts': 'trunk\n', 'trunk.ts': 'trunk work\n' });
  });

  /** Land a task PR on the mission branch the way the kernel's merge door does: pinned, method by context. */
  function landTaskPr(name: string, files: Record<string, string>, context: unknown = {}) {
    gh.branch(name, BRANCH);
    const prHead = gh.commit(name, files);
    return gh.landPr({ base: BRANCH, headBranch: name, expectedHeadSha: prHead, method: resolveMergeMethod(context) as 'merge' | 'squash' });
  }

  const contains = (ref: string, files: Record<string, string>) => {
    for (const [p, c] of Object.entries(files)) expect(gh.read(ref, p)).toBe(c.trim());
  };

  it('conflict → one repair task → merge-commit landing → ancestry proven → settled, across a task landing and further trunk moves', async () => {
    const missionHeadAtConflict = gh.head(BRANCH)!;
    const devAtConflict = gh.head('dev')!;

    // 1. The refresh conflicts: one task, recording what it must prove.
    const first = await refreshMissionIntegrationBranch('m-1', { trigger: 'start' });
    expect(first).toMatchObject({ kind: 'conflict', dispatched: true });
    expect(insertedTasks).toHaveLength(1);
    const repair = insertedTasks[0];
    expect(repair.context).toMatchObject({ requireMergeCommit: true, refreshTrunkSha: devAtConflict, refreshMissionHeadSha: missionHeadAtConflict });
    expect(gh.head(BRANCH)).toBe(missionHeadAtConflict); // a 409 wrote nothing

    // 2. While it runs: a task PR lands on the mission branch, trunk moves again,
    //    and more starts (a delayed or duplicate trigger) arrive. They coalesce.
    expect(landTaskPr('buildd/task-x', { 'task-x.ts': 'task x\n' }).merged).toBe(true);
    gh.commit('dev', { 'dev2.ts': 'more trunk\n' });
    for (let i = 0; i < 3; i++) {
      expect(await refreshMissionIntegrationBranch('m-1', { trigger: i % 2 ? 'backstop' : 'start' })).toMatchObject({ kind: 'skipped', reason: 'conflict_task_open' });
    }
    expect(mergesCalls).toBe(1);
    expect(insertedTasks).toHaveLength(1);

    // 3. The worker finishes with its PR open: worker completion is not settlement.
    tasksById[repair.id].status = 'completed';
    prWorkerByTaskId[repair.id] = { prNumber: 101 };
    const resolution = gh.resolveMerge('buildd/repair', BRANCH, 'dev', { 'shared.ts': 'resolved\n' });
    prs[101] = { state: 'open', merged: false, head: { sha: resolution } };
    expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'start' })).toMatchObject({ kind: 'skipped', reason: 'conflict_task_open' });
    expect(missionRow.branchRefreshConflictTaskId).toBe(repair.id);

    // 4. The repair PR lands the way every merge door lands it: a merge commit.
    const landed = gh.landPr({ base: BRANCH, headBranch: 'buildd/repair', expectedHeadSha: resolution, method: resolveMergeMethod(repair.context) as 'merge' });
    expect(landed.merged).toBe(true);
    prs[101] = { state: 'closed', merged: true, head: { sha: resolution } };

    // 5. The next refresh proves ancestry on the live head, clears the pointer,
    //    and finds trunk already contained: GitHub answers 204, no new commit.
    const headBefore = gh.head(BRANCH);
    const settled = await refreshMissionIntegrationBranch('m-1', { trigger: 'backstop' });
    expect(settled).toEqual({ kind: 'skipped', reason: 'already_current' });
    expect(missionRow.branchRefreshConflictTaskId).toBeNull();
    expect(missionRow.branchRefreshHeadSha).toBe(gh.head('dev'));
    expect(gh.head(BRANCH)).toBe(headBefore);
    expect(insertedTasks).toHaveLength(1);

    // No lost commits: every side's work and both starting heads are in the branch.
    contains(BRANCH, { 'mission.ts': 'mission work', 'task-x.ts': 'task x', 'trunk.ts': 'trunk work', 'dev2.ts': 'more trunk', 'shared.ts': 'resolved' });
    for (const sha of [missionHeadAtConflict, devAtConflict, gh.head('dev')!]) expect(gh.isAncestor(sha, gh.head(BRANCH)!)).toBe(true);
  });

  it('a squash-landed repair is caught by the live ancestry check; one real merge repairs it; no second task either way', async () => {
    await refreshMissionIntegrationBranch('m-1', { trigger: 'start' });
    const repair = insertedTasks[0];
    tasksById[repair.id].status = 'completed';
    prWorkerByTaskId[repair.id] = { prNumber: 102 };
    const resolution = gh.resolveMerge('buildd/repair', BRANCH, 'dev', { 'shared.ts': 'resolved\n' });
    // A person merges it on GitHub with "Squash and merge": right tree, wrong ancestry.
    expect(gh.landPr({ base: BRANCH, headBranch: 'buildd/repair', expectedHeadSha: resolution, method: 'squash' }).merged).toBe(true);
    prs[102] = { state: 'closed', merged: true, head: { sha: resolution } };
    expect(gh.read(BRANCH, 'trunk.ts')).toBe('trunk work'); // the content is there...
    expect(gh.isAncestor(repair.context.refreshTrunkSha, gh.head(BRANCH)!)).toBe(false); // ...the history is not

    const verdict = await verifyRefreshLanded({
      installationId: 1, repoFullName: 'o/r', branch: BRANCH, trunk: 'dev',
      refresh: { trunk: 'dev', trunkSha: repair.context.refreshTrunkSha, missionHeadSha: repair.context.refreshMissionHeadSha },
      prHeadSha: resolution, api: mockGithubApi as any,
    });
    expect(verdict).toMatchObject({ ok: false, transient: false });

    for (let i = 0; i < 2; i++) {
      expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'backstop' })).toMatchObject({ kind: 'skipped', reason: 'refresh_unverified' });
    }
    expect(insertedTasks).toHaveLength(1);
    expect(missionRow.branchRefreshHeadSha).toBeNull();

    // The documented repair: a real merge of dev into the branch, landed as a merge commit.
    const fix = gh.resolveMerge('buildd/repair-2', BRANCH, 'dev', {});
    expect(gh.landPr({ base: BRANCH, headBranch: 'buildd/repair-2', expectedHeadSha: fix, method: 'merge' }).merged).toBe(true);
    expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'backstop' })).toEqual({ kind: 'skipped', reason: 'already_current' });
    expect(missionRow.branchRefreshConflictTaskId).toBeNull();
    expect(insertedTasks).toHaveLength(1);
  });

  describe('a clean trunk', () => {
    beforeEach(() => {
      // Make the refresh clean: trunk's change no longer touches the mission's file.
      gh.dispose();
      gh = gitHubOverGit();
      gh.commit('dev', { 'shared.ts': 'v0\n' }, 'base');
      gh.branch(BRANCH, 'dev');
      gh.commit(BRANCH, { 'mission.ts': 'mission work\n' });
      gh.commit('dev', { 'trunk.ts': 'trunk work\n' });
    });

    it('refresh vs a task PR landing, in either order: both land and nothing is lost', async () => {
      // Task lands first, then the refresh.
      expect(landTaskPr('buildd/task-a', { 'a.ts': 'a\n' }).merged).toBe(true);
      expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'start' })).toMatchObject({ kind: 'merged' });
      // Refresh first, then a task approved at its head before the base moved lands.
      gh.commit('dev', { 'dev2.ts': 'more trunk\n' });
      gh.branch('buildd/task-b', BRANCH);
      const bHead = gh.commit('buildd/task-b', { 'b.ts': 'b\n' });
      expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'start' })).toMatchObject({ kind: 'merged' });
      // The task PR's head did not move, so its pinned landing still lands; the base move is inside the result.
      expect(gh.landPr({ base: BRANCH, headBranch: 'buildd/task-b', expectedHeadSha: bHead, method: 'squash' }).merged).toBe(true);

      contains(BRANCH, { 'mission.ts': 'mission work', 'a.ts': 'a', 'b.ts': 'b', 'trunk.ts': 'trunk work', 'dev2.ts': 'more trunk' });
      expect(gh.isAncestor(gh.head('dev')!, gh.head(BRANCH)!)).toBe(true);
      expect(insertedTasks).toHaveLength(0);
    });

    it('refresh vs the mission PR landing: an approval pinned to the old head cannot land the moved head', async () => {
      const approvedHead = gh.head(BRANCH)!;
      // Trunk moves and a mission task starts: the refresh moves the mission PR's head.
      gh.commit('dev', { 'dev2.ts': 'more trunk\n' });
      expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'start' })).toMatchObject({ kind: 'merged' });
      const movedHead = gh.head(BRANCH)!;
      expect(movedHead).not.toBe(approvedHead);

      // The landing pinned to what was approved is refused, and nothing reaches trunk.
      const devBefore = gh.head('dev');
      expect(gh.landPr({ base: 'dev', headBranch: BRANCH, expectedHeadSha: approvedHead, method: 'squash' })).toEqual({ merged: false, status: 409 });
      expect(gh.head('dev')).toBe(devBefore);

      // The kernel re-binds to the moved head (carry-forward or a delta round, §8.3) and lands that.
      expect(gh.landPr({ base: 'dev', headBranch: BRANCH, expectedHeadSha: movedHead, method: 'squash' }).merged).toBe(true);
      contains('dev', { 'mission.ts': 'mission work', 'trunk.ts': 'trunk work', 'dev2.ts': 'more trunk' });

      // After the mission PR merged, the refresh never writes to the branch again.
      mockFindMissionPrOwner.mockResolvedValue({ state: 'merged' });
      gh.commit('dev', { 'dev3.ts': 'after merge\n' });
      const calls = mergesCalls;
      expect(await refreshMissionIntegrationBranch('m-1', { trigger: 'start' })).toEqual({ kind: 'skipped', reason: 'mission_pr_merged' });
      expect(mergesCalls).toBe(calls);
      expect(gh.head(BRANCH)).toBe(movedHead);
    });
  });
});
