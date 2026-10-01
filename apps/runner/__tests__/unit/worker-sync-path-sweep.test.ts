/**
 * The sync tick's observed-touch report is the base-pinned checkpoint sweep
 * (conflict-aware-orchestration.md §2), not committed-only `origin/HEAD`/`dev`
 * observation:
 *  - measured against the worker's resolved base (a mission branch here), so
 *    the integration branch's own history is never reported as this task's
 *  - staged, unstaged and untracked files (Bash writes) are included
 *  - a collision the server reports stops the task in enforce mode (handed to
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

describe('sync sweep', () => {
  test('reports committed + untracked changes against the mission base, not trunk', async () => {
    const worker = makeWorker();
    await makeSync(worker).sync.syncWorkerToServer(worker);
    expect(payloads[0].touchedPaths).toEqual(['src/from-bash.ts', 'src/mine.ts']);
  });

  test('measures against the PR base even when the worktree was cut from another ref (a resume)', async () => {
    // The worktree base names the resume branch == HEAD here; the PR base is the mission branch.
    const worker = makeWorker({ worktreeBaseRef: 'HEAD', prBaseRef: 'origin/mission/m-1' });
    await makeSync(worker).sync.syncWorkerToServer(worker);
    expect(payloads[0].touchedPaths).toEqual(['src/from-bash.ts', 'src/mine.ts']);
    // A plain sync offers only what is new; the re-offer is for checkpoints.
    expect(payloads[0].checkpointSweep).toBeUndefined();
  });

  test('no resolved base: only uncommitted changes, never a trunk fallback', async () => {
    const worker = makeWorker({ worktreeBaseRef: undefined, prBaseRef: undefined });
    await makeSync(worker).sync.syncWorkerToServer(worker);
    expect(payloads[0].touchedPaths).toEqual(['src/from-bash.ts']);
    expect(payloads[0].touchedPaths).not.toContain('src/sibling.ts');
  });

  test('enforce: a server-reported collision stops the task', async () => {
    response = { pathCollisions: [{ path: 'src/from-bash.ts', blockingTaskId: BLOCKER, blockingTaskTitle: 'Other', blockingPath: 'src' }] };
    const worker = makeWorker({ pathClaimMode: 'enforce' });
    const { sync, onPathCollision } = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    expect(onPathCollision).toHaveBeenCalledTimes(1);
    expect(onPathCollision.mock.calls[0][1]).toMatchObject({ path: 'src/from-bash.ts', blockingTaskId: BLOCKER, source: 'sync' });
    expect(worker.pathCollision).toMatchObject({ path: 'src/from-bash.ts' });
  });

  test('advisory: a reported collision is not enforced', async () => {
    response = { pathCollisions: [{ path: 'src/from-bash.ts', blockingTaskId: BLOCKER }] };
    const worker = makeWorker();
    const { sync, onPathCollision } = makeSync(worker);
    await sync.syncWorkerToServer(worker);
    expect(onPathCollision).not.toHaveBeenCalled();
    expect(worker.pathCollision).toBeUndefined();
  });
});
