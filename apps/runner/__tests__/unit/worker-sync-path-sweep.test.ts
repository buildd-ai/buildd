/**
 * The sync tick's working-set report (path-claim-ownership.md) is the
 * base-pinned sweep (conflict-aware-orchestration.md §2) sent as a DELTA since
 * the server's last ACK, not committed-only `origin/HEAD`/`dev` observation:
 *  - measured against the worker's resolved base (a mission branch here), so
 *    the integration branch's own history is never reported as this task's
 *  - staged, unstaged and untracked files (Bash writes) are included
 *  - the steady state sends nothing; a reverted file is a removal
 *  - a holder the server reports stops the task in enforce mode (handed to
 *    onPathCollision) and is only logged in advisory mode
 *
 * Real git in a throwaway repo.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-sync-path-sweep.test.ts
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

mock.module('../../src/worker-store', () => ({
  saveWorker: mock(() => {}),
  loadAllWorkers: mock(() => []),
}));
mock.module('../../src/git-operations', () => ({
  cleanupWorktree: mock(async () => {}),
  removeWorktreeIfUnowned: mock(async () => {}),
}));
mock.module('../../src/session-logger', () => ({ sessionLog: mock(() => {}) }));

import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorkerSync, type WorkerSyncContext } from '../../src/worker-sync';

const GIT = '-c user.email=t@example.com -c user.name=t -c commit.gpgsign=false';
const BLOCKER = 'bbbbbbbb-1111-2222-3333-444444444444';
const sh = (cwd: string, cmd: string) => execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

let tmp: string;
let work: string;
let response: any;
const payloads: any[] = [];
const updateWorker = mock(async (_id: string, u: any) => { payloads.push(u); return response; });

beforeEach(() => {
  payloads.length = 0;
  response = {};
  updateWorker.mockImplementation(async (_id: string, u: any) => { payloads.push(u); return response; });
  tmp = mkdtempSync(join(tmpdir(), 'wsps-'));
  const origin = join(tmp, 'origin.git');
  work = join(tmp, 'work');
  sh(tmp, `git init -q --bare -b dev ${origin}`);
  sh(tmp, `git clone -q ${origin} ${work}`);
  sh(work, 'git checkout -q -b dev');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src/a.ts'), 'a\n');
  sh(work, `git add -A && git ${GIT} commit -q -m base && git push -q origin dev`);
  sh(work, 'git checkout -q -b mission/m-1');
  writeFileSync(join(work, 'src/sibling.ts'), 's\n');
  sh(work, `git add -A && git ${GIT} commit -q -m sib && git push -q origin mission/m-1`);
  sh(work, 'git checkout -q -b buildd/task-1');
  writeFileSync(join(work, 'src/mine.ts'), 'm\n');
  sh(work, `git add -A && git ${GIT} commit -q -m mine`);
  writeFileSync(join(work, 'src/from-bash.ts'), 'b\n');
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makeWorker(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'w-sweep', taskId: 'task-1', status: 'working', currentAction: '', milestones: [], subagentTasks: [],
    phaseText: '', phaseToolCount: 0, startedAt: Date.now() - 1000, lastActivity: Date.now(),
    worktreePath: work, worktreeBaseRef: 'origin/mission/m-1', prBaseRef: 'origin/mission/m-1', ...overrides,
  };
}

function makeSync(worker: any, onPathCollision = mock((_w: any, _c: any) => {})) {
  const ctx: WorkerSyncContext = {
    config: { localUiUrl: 'http://localhost:8766' } as any,
    buildd: { updateWorker } as any,
    workers: new Map([[worker.id, worker]]),
    sessions: new Map(),
    dirtyWorkers: new Set<string>(),
    dirtyForDisk: new Set<string>(),
    emit: mock(() => {}),
    abort: mock(async () => {}) as any,
    sendMessage: mock(async () => {}) as any,
    getAdaptiveStaleTimeout: () => 300_000,
    setAdaptiveStaleTimeout: mock(() => {}),
    recentCycleTimes: [],
    probedWorkers: new Set<string>(),
    addMilestone: mock(() => {}),
    buildUserMessage: mock((content: string) => ({ content })),
    unsubscribeFromWorker: mock(() => {}),
    onPathCollision,
  };
  return { sync: new WorkerSync(ctx), onPathCollision };
}

/** A server answering the working-set protocol: leases everything, blocks `held`. */
function ackAll(held: Record<string, string> = {}) {
  updateWorker.mockImplementation(async (_id: string, u: any) => {
    payloads.push(u);
    const d = u.workingSet;
    if (!d) return response;
    const blocked = d.add.filter((p: string) => held[p]).map((p: string) => ({ path: p, blockingTaskId: held[p], blockingTaskTitle: 'Other', blockingPath: 'src' }));
    return {
      ...response,
      workingSetAck: {
        generation: d.generation, acquired: d.add.filter((p: string) => !held[p]), blocked, released: d.remove,
        heldCount: 0, applied: true, coverage: blocked.length ? 'blocked' : d.complete ? 'complete' : 'partial',
      },
    };
  });
}

describe('sync sweep → working-set delta', () => {
  test('reports committed + untracked changes against the mission base, not trunk, as a delta the server leases', async () => {
    ackAll();
    const worker = makeWorker();
    await makeSync(worker).sync.syncWorkerToServer(worker);
    expect(payloads[0].workingSet).toMatchObject({ generation: 1, add: ['src/from-bash.ts', 'src/mine.ts'], remove: [], complete: true, includeHeld: true });
    // The same paths double as the (bounded) observed sample for older servers and the dashboard.
    expect(payloads[0].touchedPaths).toEqual(['src/from-bash.ts', 'src/mine.ts']);
    expect(payloads[0].pendingPaths).toBeUndefined();
    expect(worker.workingSet.acked).toEqual(['src/from-bash.ts', 'src/mine.ts']);
  });

  test('the steady state resends nothing: the next tick carries no paths at all', async () => {
    ackAll();
    const worker = makeWorker();
    const { sync } = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    await sync.syncWorkerToServer(worker);
    expect(payloads[1].workingSet).toBeUndefined();
    expect(payloads[1].touchedPaths).toBeUndefined();
  });

  test('a reverted file goes out as a removal once, and only when the sweep could see the whole set', async () => {
    ackAll();
    const worker = makeWorker();
    const { sync } = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    rmSync(join(work, 'src/from-bash.ts'));
    await sync.syncWorkerToServer(worker);
    expect(payloads[1].workingSet).toMatchObject({ add: [], remove: ['src/from-bash.ts'], complete: true });
    expect(worker.workingSet.acked).toEqual(['src/mine.ts']);
    await sync.syncWorkerToServer(worker);
    expect(payloads[2].workingSet).toBeUndefined();
  });

  test('measures against the PR base even when the worktree was cut from another ref (a resume)', async () => {
    ackAll();
    // The worktree base names the resume branch == HEAD here; the PR base is the mission branch.
    const worker = makeWorker({ worktreeBaseRef: 'HEAD', prBaseRef: 'origin/mission/m-1' });
    await makeSync(worker).sync.syncWorkerToServer(worker);
    expect(payloads[0].workingSet.add).toEqual(['src/from-bash.ts', 'src/mine.ts']);
    expect(payloads[0].checkpointSweep).toBeUndefined();
  });

  test('no resolved base: only uncommitted changes, never a trunk fallback', async () => {
    ackAll();
    const worker = makeWorker({ worktreeBaseRef: undefined, prBaseRef: undefined });
    await makeSync(worker).sync.syncWorkerToServer(worker);
    expect(payloads[0].workingSet.add).toEqual(['src/from-bash.ts']);
    expect(payloads[0].workingSet.add).not.toContain('src/sibling.ts');
  });

  test('an older server that does not ACK leaves the delta pending: it is offered again, never assumed held', async () => {
    const worker = makeWorker();
    const { sync } = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    await sync.syncWorkerToServer(worker);
    expect(payloads[1].workingSet.add).toEqual(['src/from-bash.ts', 'src/mine.ts']);
    expect(worker.workingSet.acked).toEqual([]);
  });

  test('enforce: a holder in the ACK stops the task', async () => {
    ackAll({ 'src/from-bash.ts': BLOCKER });
    const worker = makeWorker({ pathClaimMode: 'enforce' });
    const { sync, onPathCollision } = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    expect(onPathCollision).toHaveBeenCalledTimes(1);
    expect(onPathCollision.mock.calls[0][1]).toMatchObject({ path: 'src/from-bash.ts', blockingTaskId: BLOCKER, source: 'sync' });
    expect(worker.pathCollision).toMatchObject({ path: 'src/from-bash.ts' });
  });

  test('enforce: a legacy pathCollisions answer still stops the task', async () => {
    response = { pathCollisions: [{ path: 'src/from-bash.ts', blockingTaskId: BLOCKER, blockingTaskTitle: 'Other', blockingPath: 'src' }] };
    const worker = makeWorker({ pathClaimMode: 'enforce' });
    const { sync, onPathCollision } = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    expect(onPathCollision).toHaveBeenCalledTimes(1);
  });

  test('advisory: a reported collision is not enforced', async () => {
    ackAll({ 'src/from-bash.ts': BLOCKER });
    const worker = makeWorker();
    const { sync, onPathCollision } = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    expect(onPathCollision).not.toHaveBeenCalled();
    expect(worker.pathCollision).toBeUndefined();
  });

  test('unproven ship checkpoints are reported on the next sync that lands, and kept when it does not', async () => {
    const worker = makeWorker({ pendingShipReports: [{ source: 'pre_push', result: 'unknown', cause: 'timeout', refused: true, attempts: 3, at: 1 }] });
    const { sync } = makeSync(worker);
    updateWorker.mockImplementationOnce(async () => { throw new Error('offline'); });
    await sync.syncWorkerToServer(worker).catch(() => {});
    expect(worker.pendingShipReports).toHaveLength(1);
    ackAll();
    await sync.syncWorkerToServer(worker);
    expect(payloads.at(-1).shipCheckpoints).toEqual([{ source: 'pre_push', result: 'unknown', cause: 'timeout', refused: true, attempts: 3, at: 1 }]);
    expect(worker.pendingShipReports).toEqual([]);
  });
});

describe('degraded declaration counter (conflict-aware-orchestration.md §3)', () => {
  test('reports new degraded path-claim calls once, as a delta', async () => {
    const worker = makeWorker({ pathClaimDegraded: 3 });
    const { sync } = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    expect(payloads[0].pathClaimDegraded).toBe(3);
    await sync.syncWorkerToServer(worker);
    expect(payloads[1].pathClaimDegraded).toBeUndefined();
    worker.pathClaimDegraded = 5;
    await sync.syncWorkerToServer(worker);
    expect(payloads[2].pathClaimDegraded).toBe(2);
  });

  test('a failed sync re-reports the same delta next time', async () => {
    const worker = makeWorker({ pathClaimDegraded: 2 });
    const { sync } = makeSync(worker);
    updateWorker.mockImplementationOnce(async () => { throw new Error('offline'); });
    await sync.syncWorkerToServer(worker).catch(() => {});
    await sync.syncWorkerToServer(worker);
    expect(payloads.at(-1).pathClaimDegraded).toBe(2);
  });
});
