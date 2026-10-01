/**
 * Checkpoint enforcement hand-off (conflict-aware-orchestration.md §2):
 *  - the checkpoint sweep offers the base-pinned worktree changes (Bash and
 *    untracked writes included) and reads the server's collision answer
 *  - an unreachable server is bounded fail-open, recorded as degraded
 *  - a collision persists state, checkpoints the worktree, reports a
 *    `Deferred:` failure the server requeues on, and ends the session — no
 *    agent is kept alive waiting for the lease
 *
 * Real git in throwaway repos; the buildd client is a stub.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/path-collision-defer.test.ts
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runCheckpointSweep,
  writeCollisionCheckpoint,
  deferOnPathCollision,
  CHECKPOINT_SYNC_DEADLINE_MS,
} from '../../src/path-collision-defer';
import type { PathCollision } from '../../src/path-claim-enforcement';

const BLOCKER = 'bbbbbbbb-1111-2222-3333-444444444444';
const GIT = '-c user.email=t@example.com -c user.name=t -c commit.gpgsign=false';

function sh(cwd: string, cmd: string) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let tmp: string;
let origin: string;
let work: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pcd-'));
  origin = join(tmp, 'origin.git');
  work = join(tmp, 'work');
  sh(tmp, `git init -q --bare -b dev ${origin}`);
  sh(tmp, `git clone -q ${origin} ${work}`);
  sh(work, 'git checkout -q -b dev');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src/a.ts'), 'a\n');
  sh(work, `git add -A && git ${GIT} commit -q -m base && git push -q origin dev`);
  sh(work, 'git checkout -q -b buildd/task-1');
  // A Bash write: never passed through a pre-edit hook.
  writeFileSync(join(work, 'src/from-bash.ts'), 'x\n');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeWorker(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'w1',
    taskId: 'task-1',
    branch: 'buildd/task-1',
    worktreePath: work,
    worktreeBaseRef: 'origin/dev',
    pathClaimMode: 'enforce',
    milestones: [],
    ...overrides,
  };
}

const collision: PathCollision = {
  path: 'src/from-bash.ts', blockingTaskId: BLOCKER, blockingTaskTitle: 'Other', blockingPath: 'src', source: 'sync', detectedAt: 1,
};

describe('runCheckpointSweep', () => {
  test('offers Bash/untracked writes measured against the resolved base, and returns the server collision', async () => {
    const updateWorker = mock(async (_id: string, _u: any) => ({
      pathCollisions: [{ path: 'src/from-bash.ts', blockingTaskId: BLOCKER, blockingTaskTitle: 'Other', blockingPath: 'src' }],
    }));
    const worker = makeWorker();

    const found = await runCheckpointSweep(worker, 'pre_push', { buildd: { updateWorker } as any, addMilestone: () => {} });

    expect(updateWorker).toHaveBeenCalledTimes(1);
    expect(updateWorker.mock.calls[0][1]).toEqual({ touchedPaths: ['src/from-bash.ts'] });
    expect(found).toMatchObject({ path: 'src/from-bash.ts', blockingTaskId: BLOCKER, source: 'pre_push' });
  });

  test('no collision reported: null', async () => {
    const updateWorker = mock(async () => ({}));
    expect(await runCheckpointSweep(makeWorker(), 'completion', { buildd: { updateWorker } as any, addMilestone: () => {} })).toBeNull();
  });

  test('a hung server is bounded: returns null within the deadline and records degraded enforcement', async () => {
    const updateWorker = mock(() => new Promise(() => {}));
    const worker = makeWorker();
    const milestones: any[] = [];
    const started = Date.now();

    const found = await runCheckpointSweep(worker, 'pre_push', {
      buildd: { updateWorker } as any,
      addMilestone: (_w, m) => milestones.push(m),
      deadlineMs: 150,
    });

    expect(found).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(worker.pathClaimDegraded).toBe(1);
    expect(milestones.some(m => String(m.label).includes('degraded'))).toBe(true);
    expect(CHECKPOINT_SYNC_DEADLINE_MS).toBeGreaterThan(0);
  });

  test('a failing server is fail-open too', async () => {
    const updateWorker = mock(async () => { throw new Error('ECONNREFUSED'); });
    const worker = makeWorker();
    expect(await runCheckpointSweep(worker, 'pre_push', { buildd: { updateWorker } as any, addMilestone: () => {} })).toBeNull();
    expect(worker.pathClaimDegraded).toBe(1);
  });

  test('no worktree, or nothing changed: no server call', async () => {
    const updateWorker = mock(async () => ({}));
    expect(await runCheckpointSweep(makeWorker({ worktreePath: undefined }), 'pre_push', { buildd: { updateWorker } as any, addMilestone: () => {} })).toBeNull();
    rmSync(join(work, 'src/from-bash.ts'));
    expect(await runCheckpointSweep(makeWorker(), 'pre_push', { buildd: { updateWorker } as any, addMilestone: () => {} })).toBeNull();
    expect(updateWorker).not.toHaveBeenCalled();
  });
});

describe('writeCollisionCheckpoint', () => {
  test('commits the dirty worktree and pushes the task branch so a later attempt can resume', () => {
    const cp = writeCollisionCheckpoint(work, 'buildd/task-1', collision, { push: true });
    expect(cp.committed).toBe(true);
    expect(cp.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(cp.pushed).toBe(true);
    expect(sh(work, 'git status --porcelain').trim()).toBe('');
    expect(sh(origin, 'git rev-parse refs/heads/buildd/task-1').trim()).toBe(cp.sha!);
    expect(sh(work, 'git log -1 --format=%s')).toContain('checkpoint');
  });

  test('push: false keeps the checkpoint local', () => {
    const cp = writeCollisionCheckpoint(work, 'buildd/task-1', collision, { push: false });
    expect(cp.committed).toBe(true);
    expect(cp.pushed).toBe(false);
    expect(() => sh(origin, 'git rev-parse --verify --quiet refs/heads/buildd/task-1')).toThrow();
  });

  test('a clean worktree commits nothing', () => {
    rmSync(join(work, 'src/from-bash.ts'));
    const cp = writeCollisionCheckpoint(work, 'buildd/task-1', collision, { push: false });
    expect(cp.committed).toBe(false);
  });
});

describe('deferOnPathCollision', () => {
  test('persists, checkpoints, reports a Deferred: failure with the collision, then ends the session', async () => {
    const calls: string[] = [];
    const updateWorker = mock(async (_id: string, _u: any) => { calls.push('patch'); return {}; });
    const abort = mock(async (_id: string, _reason?: string) => { calls.push('abort'); });
    const save = mock((_w: any) => { calls.push('save'); });
    const worker = makeWorker();

    await deferOnPathCollision(worker, collision, { buildd: { updateWorker } as any, abort, save, addMilestone: () => {} });

    expect(worker.pathCollision).toMatchObject({ path: 'src/from-bash.ts' });
    expect(save).toHaveBeenCalled();
    const body = updateWorker.mock.calls[0][1];
    expect(body.status).toBe('failed');
    expect(body.error.startsWith('Deferred:')).toBe(true);
    expect(body.error).toContain('bbbbbbbb');
    expect(body.pathCollision).toMatchObject({ path: 'src/from-bash.ts', blockingTaskId: BLOCKER, checkpoint: { committed: true, pushed: true } });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort.mock.calls[0][1]!.startsWith('Deferred:')).toBe(true);
    // The deferral is reported before the session is torn down.
    expect(calls.indexOf('patch')).toBeLessThan(calls.indexOf('abort'));
  });

  test('an existing PR keeps the checkpoint local (pushing would ship the colliding change)', async () => {
    const updateWorker = mock(async (_id: string, _u: any) => ({}));
    const worker = makeWorker({ prUrl: 'https://github.com/o/r/pull/1' });
    await deferOnPathCollision(worker, collision, { buildd: { updateWorker } as any, abort: async () => {}, save: () => {}, addMilestone: () => {} });
    expect(updateWorker.mock.calls[0][1].pathCollision.checkpoint).toMatchObject({ committed: true, pushed: false });
  });

  test('runs once even when two detectors fire', async () => {
    const updateWorker = mock(async () => ({}));
    const abort = mock(async () => {});
    const worker = makeWorker();
    const deps = { buildd: { updateWorker } as any, abort, save: () => {}, addMilestone: () => {} };
    await Promise.all([deferOnPathCollision(worker, collision, deps), deferOnPathCollision(worker, collision, deps)]);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(updateWorker).toHaveBeenCalledTimes(1);
  });

  test('a failed report still ends the session: the deferral never keeps an agent alive', async () => {
    const updateWorker = mock(async () => { throw new Error('down'); });
    const abort = mock(async () => {});
    await deferOnPathCollision(makeWorker(), collision, { buildd: { updateWorker } as any, abort, save: () => {}, addMilestone: () => {} });
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
