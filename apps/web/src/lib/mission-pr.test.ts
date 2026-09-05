import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * Option A′ — the mission integration PR.
 *
 * Three classes of assertion here, and the third is the one that was missing:
 *
 *  1. **Never complete over an empty set.** A mission with no deliverable tasks
 *     trivially satisfies "every task landed, every PR merged"; a `complete`
 *     there opens a PR with no commits on it.
 *  2. **Scope.** Mocking `db` makes a WHERE clause unobservable, so the
 *     predicates are captured and asserted directly. Without that, dropping
 *     `where: eq(tasks.missionId, missionId)` would leave this file green while
 *     `evaluateMissionWorkState` read *every task in the database* to decide
 *     whether one mission was done.
 *  3. **The opt-in guard.** `openMissionIntegrationPr` returning early for a
 *     mission that never opted in is the single line holding up the whole
 *     "nothing changes until you opt in" argument, and nothing exercised it —
 *     deleting it made a non-opted-in mission open a PR and create rows on
 *     every merge, with no test failing.
 */

// ── Captured query predicates (the point of items 2 above) ───────────────────
let taskQueryWhere: unknown = null;
let workerQueryWhere: unknown = null;

let taskRowsForMission: any[] = [];
let workerRowsByTask: Record<string, any[]> = {};
let missionRow: any = null;
let workspaceRow: any = null;
let repoRow: any = null;
let orphanWorkerRow: any = null;

const inserts: Array<{ table: string; values: any }> = [];
const updates: Array<{ setValues: any }> = [];
const githubCalls: Array<{ path: string; method: string; body?: any }> = [];
let githubResponses: Record<string, any> = {};
let githubThrows: Record<string, string> = {};

mock.module('drizzle-orm', () => ({
  eq: (col: any, val: any) => ({ _op: 'eq', col, val }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  isNull: (col: any) => ({ _op: 'isNull', col }),
  isNotNull: (col: any) => ({ _op: 'isNotNull', col }),
  inArray: (col: any, vals: any[]) => ({ _op: 'inArray', col, vals }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'tasks.id', missionId: 'tasks.mission_id' },
  workers: {
    id: 'workers.id', taskId: 'workers.task_id', prUrl: 'workers.pr_url',
    mergedAt: 'workers.merged_at',
  },
  missions: { id: 'missions.id', primaryPrNumber: 'missions.primary_pr_number' },
  missionNotes: {},
  workspaces: { id: 'workspaces.id' },
  githubRepos: { id: 'github_repos.id' },
}));

/** Does this (possibly nested) predicate contain eq(col, val)? */
function hasEq(where: any, col: string, val?: unknown): boolean {
  if (!where) return false;
  if (where._op === 'eq') return where.col === col && (val === undefined || where.val === val);
  if (where._op === 'and') return where.args.some((a: any) => hasEq(a, col, val));
  return false;
}
function hasOp(where: any, op: string, col?: string): boolean {
  if (!where) return false;
  if (where._op === op) return col === undefined || where.col === col;
  if (where._op === 'and') return where.args.some((a: any) => hasOp(a, op, col));
  return false;
}
function inArrayValues(where: any): string[] | null {
  if (!where) return null;
  if (where._op === 'inArray') return where.vals;
  if (where._op === 'and') {
    for (const a of where.args) { const v = inArrayValues(a); if (v) return v; }
  }
  return null;
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findMany: (args: any) => {
          taskQueryWhere = args?.where;
          return Promise.resolve(taskRowsForMission);
        },
      },
      workers: {
        findMany: (args: any) => {
          workerQueryWhere = args?.where;
          const ids = inArrayValues(args?.where);
          const rows = ids
            ? ids.flatMap(id => workerRowsByTask[id] ?? [])
            : Object.values(workerRowsByTask).flat();
          // `findMany` on the owner lookup additionally filters prUrl non-null.
          return Promise.resolve(
            hasOp(args?.where, 'isNotNull', 'workers.pr_url')
              ? rows.filter(r => r.prUrl)
              : rows,
          );
        },
        findFirst: () => Promise.resolve(orphanWorkerRow),
      },
      missions: { findFirst: () => Promise.resolve(missionRow) },
      workspaces: { findFirst: () => Promise.resolve(workspaceRow) },
      githubRepos: { findFirst: () => Promise.resolve(repoRow) },
    },
    insert: (table: any) => ({
      values: (v: any) => {
        inserts.push({ table: String(Object.keys(table ?? {})[0] ?? 'unknown'), values: v });
        return {
          returning: () => Promise.resolve([{ id: `inserted-${inserts.length}` }]),
          then: (r: any) => r(undefined),
        };
      },
    }),
    update: () => ({
      set: (setValues: any) => ({
        where: () => { updates.push({ setValues }); return Promise.resolve(); },
      }),
    }),
  },
}));

mock.module('@/lib/github', () => ({
  githubApi: (_id: number, path: string, opts?: any) => {
    githubCalls.push({
      path,
      method: opts?.method ?? 'GET',
      body: opts?.body ? JSON.parse(opts.body) : undefined,
    });
    for (const [frag, msg] of Object.entries(githubThrows)) {
      if (path.includes(frag)) return Promise.reject(new Error(msg));
    }
    for (const [frag, res] of Object.entries(githubResponses)) {
      if (path.includes(frag)) return Promise.resolve(res);
    }
    return Promise.resolve({});
  },
}));

const {
  MISSION_PR_TASK_PREFIX,
  evaluateMissionWorkState,
  findMissionPrOwner,
  isMissionPrTask,
  maybeOpenMissionIntegrationPr,
  openMissionIntegrationPr,
  trunkBranches,
} = await import('./mission-pr');

const MISSION_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const BRANCH = 'mission/checkout-arc-1a2b3c4d';
const T0 = new Date('2026-01-01T00:00:00Z');

function workTask(id: string, status: string) {
  return { id, title: `Task ${id}`, status, mode: 'execution', taskClass: 'work' };
}
function ownerTask(id = 't-own') {
  return {
    id, title: `${MISSION_PR_TASK_PREFIX}Checkout arc`,
    status: 'completed', mode: 'execution', taskClass: 'bookkeeping',
  };
}
function worker(over: Partial<Record<string, any>> = {}) {
  return {
    taskId: 't-1', prUrl: null, prNumber: null, prBaseRef: null, mergedAt: null,
    prLifecycleStatus: null, startedAt: T0, createdAt: T0, id: 'w-1', ...over,
  };
}

beforeEach(() => {
  taskQueryWhere = null;
  workerQueryWhere = null;
  taskRowsForMission = [];
  workerRowsByTask = {};
  orphanWorkerRow = null;
  inserts.length = 0;
  updates.length = 0;
  githubCalls.length = 0;
  githubResponses = {};
  githubThrows = {};
  missionRow = { id: MISSION_ID, title: 'Checkout arc', workspaceId: 'ws-1', workingBranch: BRANCH, integrationBranchEnabled: true };
  workspaceRow = { id: 'ws-1', githubRepoId: 'repo-1', githubInstallationId: 42, gitConfig: { targetBranch: 'dev' } };
  repoRow = { fullName: 'example/demo-app', defaultBranch: 'main', installation: { installationId: 42 } };
});

// ── Scope: the predicates a mocked db would otherwise hide ───────────────────

describe('evaluateMissionWorkState — query scope', () => {
  it('scopes the task read to this mission', async () => {
    // Without this, the function decides one mission's completeness from every
    // task in the database — a tenancy break that no behavioural assertion in
    // this file could see.
    taskRowsForMission = [workTask('t-1', 'completed')];
    workerRowsByTask['t-1'] = [worker({ prUrl: 'u', mergedAt: T0, prBaseRef: BRANCH })];
    await evaluateMissionWorkState(MISSION_ID);
    expect(hasEq(taskQueryWhere, 'tasks.mission_id', MISSION_ID)).toBe(true);
  });

  it('scopes the worker read to this mission’s deliverable tasks only', async () => {
    taskRowsForMission = [workTask('t-1', 'completed'), ownerTask()];
    workerRowsByTask['t-1'] = [worker({ prUrl: 'u', mergedAt: T0, prBaseRef: BRANCH })];
    await evaluateMissionWorkState(MISSION_ID);
    expect(inArrayValues(workerQueryWhere)).toEqual(['t-1']);
  });
});

describe('evaluateMissionWorkState', () => {
  it('is never complete for a mission with no deliverable tasks', async () => {
    const s = await evaluateMissionWorkState(MISSION_ID);
    expect(s.complete).toBe(false);
    expect(s.reason).toBe('no_deliverable_work');
  });

  it('is not complete while a deliverable task is unfinished', async () => {
    taskRowsForMission = [workTask('t-1', 'completed'), workTask('t-2', 'in_progress')];
    workerRowsByTask['t-1'] = [worker({ prUrl: 'u', mergedAt: T0, prBaseRef: BRANCH })];
    const s = await evaluateMissionWorkState(MISSION_ID);
    expect(s.reason).toBe('tasks_unfinished');
    expect(s.unfinishedTaskCount).toBe(1);
  });

  it('counts a task whose PR merged as landed even if its row still says in_progress', async () => {
    // The webhook stamps workers.mergedAt BEFORE tasks.status. Two final task
    // PRs merging concurrently each saw the other's task as in_progress and both
    // declined to open the mission PR — and the webhook is the only trigger, so
    // both declining meant it never opened.
    taskRowsForMission = [workTask('t-1', 'completed'), workTask('t-2', 'in_progress')];
    workerRowsByTask['t-1'] = [worker({ prUrl: 'u1', mergedAt: T0, prBaseRef: BRANCH })];
    workerRowsByTask['t-2'] = [worker({ taskId: 't-2', prUrl: 'u2', mergedAt: T0, prBaseRef: BRANCH })];
    const s = await evaluateMissionWorkState(MISSION_ID);
    expect(s.complete).toBe(true);
  });

  it('is not complete while a deliverable PR is open', async () => {
    taskRowsForMission = [workTask('t-1', 'completed')];
    workerRowsByTask['t-1'] = [worker({ prUrl: 'u', prLifecycleStatus: 'pr_open' })];
    const s = await evaluateMissionWorkState(MISSION_ID);
    expect(s.reason).toBe('prs_unmerged');
    expect(s.unmergedPrCount).toBe(1);
  });

  it('ignores a PR that was closed without merging', async () => {
    // One superseded retry PR, or one a human closed, used to pin the mission at
    // prs_unmerged forever. Every other gate in the codebase carries this
    // exclusion; this one did not.
    taskRowsForMission = [workTask('t-1', 'completed'), workTask('t-2', 'failed')];
    workerRowsByTask['t-1'] = [worker({ prUrl: 'u1', mergedAt: T0, prBaseRef: BRANCH })];
    workerRowsByTask['t-2'] = [worker({ taskId: 't-2', prUrl: 'u2', prLifecycleStatus: 'closed' })];
    const s = await evaluateMissionWorkState(MISSION_ID);
    expect(s.complete).toBe(true);
  });

  it('ignores an unresolvable PR too', async () => {
    taskRowsForMission = [workTask('t-1', 'completed'), workTask('t-2', 'failed')];
    workerRowsByTask['t-1'] = [worker({ prUrl: 'u1', mergedAt: T0, prBaseRef: BRANCH })];
    workerRowsByTask['t-2'] = [worker({ taskId: 't-2', prUrl: 'u2', prLifecycleStatus: 'unresolvable' })];
    expect((await evaluateMissionWorkState(MISSION_ID)).complete).toBe(true);
  });

  it('reads only the newest worker of a retried task', async () => {
    // A task re-claimed after a worker died: the dead worker's PR was closed,
    // the live one merged. Scanning ALL workers blocked the mission forever.
    taskRowsForMission = [workTask('t-1', 'completed')];
    workerRowsByTask['t-1'] = [
      worker({ id: 'old', prUrl: 'u-old', prLifecycleStatus: 'pr_open', startedAt: T0 }),
      worker({ id: 'new', prUrl: 'u-new', mergedAt: T0, prBaseRef: BRANCH, startedAt: new Date('2026-02-01T00:00:00Z') }),
    ];
    expect((await evaluateMissionWorkState(MISSION_ID)).complete).toBe(true);
  });

  it('falls back to createdAt when startedAt is null', async () => {
    // workers.startedAt is nullable with no default, and Postgres DESC sorts
    // NULLs first — so a never-started worker would outrank the real one.
    taskRowsForMission = [workTask('t-1', 'completed')];
    workerRowsByTask['t-1'] = [
      worker({ id: 'merged', prUrl: 'u', mergedAt: T0, prBaseRef: BRANCH, startedAt: null, createdAt: T0 }),
      worker({ id: 'never-started', prUrl: 'u2', prLifecycleStatus: 'pr_open', startedAt: null, createdAt: new Date('2025-01-01T00:00:00Z') }),
    ];
    expect((await evaluateMissionWorkState(MISSION_ID)).complete).toBe(true);
  });

  it('reports how much landed on the integration branch', async () => {
    // Zero means there is nothing for a mission PR to carry — the signal that
    // keeps an all-cancelled mission from being held open for an empty PR.
    taskRowsForMission = [workTask('t-1', 'cancelled'), workTask('t-2', 'cancelled')];
    const s = await evaluateMissionWorkState(MISSION_ID);
    expect(s.complete).toBe(true);
    expect(s.landedOnIntegrationCount).toBe(0);
  });

  it('does not count a merge into trunk as landed on the integration branch', async () => {
    taskRowsForMission = [workTask('t-1', 'completed')];
    workerRowsByTask['t-1'] = [worker({ prUrl: 'u', mergedAt: T0, prBaseRef: 'dev' })];
    const s = await evaluateMissionWorkState(MISSION_ID);
    expect(s.complete).toBe(true);
    expect(s.landedOnIntegrationCount).toBe(0);
  });
});

// ── The opt-in guard, and the owner-state logic ──────────────────────────────

describe('openMissionIntegrationPr — the opt-in guard', () => {
  it('refuses for a mission that has not opted in, touching nothing', async () => {
    // The single line the whole "nothing changes until you opt in" argument
    // rests on. Deleting it made a non-opted-in mission open a PR and create a
    // task and a worker on every merge, with no test failing.
    missionRow = { ...missionRow, integrationBranchEnabled: false };
    taskRowsForMission = [workTask('t-1', 'completed')];
    workerRowsByTask['t-1'] = [worker({ prUrl: 'u', mergedAt: T0, prBaseRef: BRANCH })];

    const r = await openMissionIntegrationPr(MISSION_ID);

    expect(r).toEqual({ ok: false, reason: 'not_opted_in' });
    expect(inserts).toEqual([]);
    expect(githubCalls).toEqual([]);
  });

  it('refuses when the mission has no working branch yet', async () => {
    missionRow = { ...missionRow, workingBranch: null };
    const r = await openMissionIntegrationPr(MISSION_ID);
    expect(r).toEqual({ ok: false, reason: 'no_working_branch' });
    expect(inserts).toEqual([]);
  });

  it('maybeOpen returns null — not a result — for a mission that never opted in', async () => {
    missionRow = { ...missionRow, integrationBranchEnabled: false };
    expect(await maybeOpenMissionIntegrationPr(MISSION_ID)).toBeNull();
    expect(githubCalls).toEqual([]);
  });

  it('maybeOpen returns null for no mission id', async () => {
    expect(await maybeOpenMissionIntegrationPr(null)).toBeNull();
    expect(await maybeOpenMissionIntegrationPr(undefined)).toBeNull();
  });
});

describe('openMissionIntegrationPr — owner state', () => {
  function landedWork() {
    taskRowsForMission = [workTask('t-1', 'completed')];
    workerRowsByTask['t-1'] = [worker({ prUrl: 'u1', mergedAt: T0, prBaseRef: BRANCH })];
  }

  it('short-circuits on an open mission PR without calling GitHub', async () => {
    landedWork();
    taskRowsForMission.push(ownerTask());
    workerRowsByTask['t-own'] = [worker({ taskId: 't-own', id: 'w-own', prUrl: 'pr-42', prNumber: 42, prLifecycleStatus: 'pr_open' })];

    const r = await openMissionIntegrationPr(MISSION_ID);

    expect(r).toEqual({ ok: true, prNumber: 42, prUrl: 'pr-42', created: false });
    expect(githubCalls).toEqual([]);
  });

  it('refuses, loudly, when a human closed the mission PR', async () => {
    // Reopening would fight an explicit decision; silence would leave the
    // mission unable to complete with nothing saying why.
    landedWork();
    taskRowsForMission.push(ownerTask());
    workerRowsByTask['t-own'] = [worker({ taskId: 't-own', id: 'w-own', prUrl: 'pr-42', prNumber: 42, prLifecycleStatus: 'closed' })];

    const r = await openMissionIntegrationPr(MISSION_ID);

    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('mission_pr_closed');
    expect(githubCalls).toEqual([]);
  });

  it('opens a second mission PR when new work lands after the first merged', async () => {
    // The false green: short-circuiting on a MERGED mission PR stranded later
    // work on the integration branch while the completion gate passed the
    // mission as shipped.
    landedWork();
    taskRowsForMission.push(ownerTask());
    workerRowsByTask['t-own'] = [worker({ taskId: 't-own', id: 'w-own', prUrl: 'pr-42', prNumber: 42, mergedAt: T0 })];
    githubResponses['/compare/'] = { ahead_by: 3 };
    githubResponses['/pulls?state=open'] = [];
    githubResponses['/pulls'] = { number: 43, html_url: 'pr-43', base: { ref: 'dev' } };

    const r = await openMissionIntegrationPr(MISSION_ID);

    expect(r).toEqual({ ok: true, prNumber: 43, prUrl: 'pr-43', created: true });
  });

  it('reports no_commits rather than opening an empty second PR', async () => {
    landedWork();
    taskRowsForMission.push(ownerTask());
    workerRowsByTask['t-own'] = [worker({ taskId: 't-own', id: 'w-own', prUrl: 'pr-42', prNumber: 42, mergedAt: T0 })];
    githubResponses['/compare/'] = { ahead_by: 0 };

    const r = await openMissionIntegrationPr(MISSION_ID);

    expect((r as { reason: string }).reason).toBe('no_commits');
    expect(githubCalls.some(c => c.method === 'POST')).toBe(false);
  });

  it('refuses while the mission’s work is incomplete', async () => {
    taskRowsForMission = [workTask('t-1', 'in_progress')];
    const r = await openMissionIntegrationPr(MISSION_ID);
    expect((r as { reason: string }).reason).toBe('work_incomplete');
    expect(inserts).toEqual([]);
  });
});

describe('openMissionIntegrationPr — recovery', () => {
  function landedWork() {
    taskRowsForMission = [workTask('t-1', 'completed')];
    workerRowsByTask['t-1'] = [worker({ prUrl: 'u1', mergedAt: T0, prBaseRef: BRANCH })];
    githubResponses['/compare/'] = { ahead_by: 2 };
  }

  it('adopts a PR GitHub already has instead of opening a duplicate', async () => {
    // Reachable when a previous attempt created the PR and died before
    // recording it. Without this, the row never carries the PR, so the PR is
    // invisible to the escalation inbox and unmergeable from the dashboard.
    landedWork();
    githubResponses['/pulls?state=open'] = [{ number: 99, html_url: 'pr-99', base: { ref: 'dev' } }];

    const r = await openMissionIntegrationPr(MISSION_ID);

    expect(r).toEqual({ ok: true, prNumber: 99, prUrl: 'pr-99', created: true });
    expect(githubCalls.some(c => c.method === 'POST')).toBe(false);
  });

  it('re-resolves the PR when the create call 422s', async () => {
    landedWork();
    let asked = 0;
    githubResponses['/pulls?state=open'] = [];
    githubThrows['/pulls'] = 'GitHub API error: 422 A pull request already exists';
    // First lookup empty, then the POST 422s, then the retry lookup finds it.
    mock.module('@/lib/github', () => ({
      githubApi: (_id: number, path: string, opts?: any) => {
        githubCalls.push({ path, method: opts?.method ?? 'GET' });
        if (path.includes('/compare/')) return Promise.resolve({ ahead_by: 2 });
        if (path.includes('/pulls?state=open')) {
          asked += 1;
          return Promise.resolve(asked === 1 ? [] : [{ number: 77, html_url: 'pr-77', base: { ref: 'dev' } }]);
        }
        if (opts?.method === 'POST') return Promise.reject(new Error('GitHub API error: 422 already exists'));
        return Promise.resolve({});
      },
    }));
    const fresh = await import('./mission-pr');
    const r = await fresh.openMissionIntegrationPr(MISSION_ID);
    expect(r).toEqual({ ok: true, prNumber: 77, prUrl: 'pr-77', created: true });
  });

  it('reuses the existing owner task rather than adding a pair per attempt', async () => {
    landedWork();
    taskRowsForMission.push(ownerTask());
    orphanWorkerRow = { id: 'w-orphan' };
    githubResponses['/pulls?state=open'] = [];
    githubResponses['/pulls'] = { number: 55, html_url: 'pr-55', base: { ref: 'dev' } };

    await openMissionIntegrationPr(MISSION_ID);

    // No new task and no new worker: it attached to the orphaned pair.
    expect(inserts.filter(i => i.values?.taskClass === 'bookkeeping')).toEqual([]);
    expect(inserts.filter(i => i.values?.runner === 'system')).toEqual([]);
  });
});

describe('findMissionPrOwner', () => {
  it('returns null when the mission has no owner task', async () => {
    taskRowsForMission = [workTask('t-1', 'completed')];
    expect(await findMissionPrOwner(MISSION_ID)).toBeNull();
  });

  it('skips an owner row that never reached GitHub', async () => {
    taskRowsForMission = [ownerTask()];
    workerRowsByTask['t-own'] = [worker({ taskId: 't-own', prUrl: null })];
    expect(await findMissionPrOwner(MISSION_ID)).toBeNull();
  });

  it('picks the newest PR-bearing owner deterministically', async () => {
    // With two owner rows in play, an unordered pick let whichever row Postgres
    // returned first decide whether the mission could ever close.
    taskRowsForMission = [ownerTask()];
    workerRowsByTask['t-own'] = [
      worker({ taskId: 't-own', id: 'old', prUrl: 'pr-1', prNumber: 1, mergedAt: T0, startedAt: T0 }),
      worker({ taskId: 't-own', id: 'new', prUrl: 'pr-2', prNumber: 2, prLifecycleStatus: 'pr_open', startedAt: new Date('2026-03-01T00:00:00Z') }),
    ];
    const owner = await findMissionPrOwner(MISSION_ID);
    expect(owner?.prNumber).toBe(2);
    expect(owner?.state).toBe('open');
  });

  it('classifies merged and closed states', async () => {
    taskRowsForMission = [ownerTask()];
    workerRowsByTask['t-own'] = [worker({ taskId: 't-own', prUrl: 'pr-1', prNumber: 1, mergedAt: T0 })];
    expect((await findMissionPrOwner(MISSION_ID))?.state).toBe('merged');

    workerRowsByTask['t-own'] = [worker({ taskId: 't-own', prUrl: 'pr-1', prNumber: 1, prLifecycleStatus: 'closed' })];
    expect((await findMissionPrOwner(MISSION_ID))?.state).toBe('closed');
  });
});

describe('isMissionPrTask', () => {
  it('requires both the bookkeeping class and the title prefix', () => {
    expect(isMissionPrTask({ title: `${MISSION_PR_TASK_PREFIX}X`, taskClass: 'bookkeeping' })).toBe(true);
    // Title alone must not confer ownership — a planner can name a deliverable
    // task anything.
    expect(isMissionPrTask({ title: `${MISSION_PR_TASK_PREFIX}X`, taskClass: 'work' })).toBe(false);
    expect(isMissionPrTask({ title: 'Mission: X', taskClass: 'bookkeeping' })).toBe(false);
    expect(isMissionPrTask({ title: null, taskClass: 'bookkeeping' })).toBe(false);
  });
});

describe('trunkBranches', () => {
  it('prefers targetBranch, then defaultBranch, then the repo default', () => {
    expect(trunkBranches({ targetBranch: 'dev', defaultBranch: 'main' }, 'master')).toEqual(['dev', 'main', 'master']);
  });

  it('drops missing entries rather than emitting empties', () => {
    // An empty string here would make `trunk.includes('')` true and let an
    // unknown base ref claim the mission PR slot.
    expect(trunkBranches({ targetBranch: null, defaultBranch: 'main' }, null)).toEqual(['main']);
    expect(trunkBranches(null, null)).toEqual([]);
  });
});
