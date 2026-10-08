/**
 * A conflict retry whose only conflicts are derived files (gitConfig.derivedFiles)
 * is finished by the runner: merged, regenerated, verified, pushed and completed
 * with no agent session. Any verification or push failure starts the agent as
 * before, with a note saying what the runner tried.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let setupPath = '';
mock.module('../../src/git-operations', () => ({
  setupWorktree: mock(async () => ({ path: setupPath, branch: 'feature', base: 'origin/main' })),
  removeWorktreeIfUnowned: mock(async () => ({ removed: true })),
  removeWorktreeIfUnownedSync: mock(() => ({ removed: true })),
  cleanupWorktree: mock(async () => ({ removed: true })),
  collectGitStats: async () => ({}),
}));
mock.module('../../src/worker-store', () => ({
  saveWorker: () => {}, loadAllWorkers: () => [], loadTerminalWorkersCached: () => [], __resetDiskWorkersCache: () => {}, loadWorker: () => null, deleteWorker: () => {},
}));
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({}), checkMcpPreFlight: () => ({ warnings: [] }),
  parseMcpJson: () => [], scanMcpServersRich: () => [],
  checkBwrapSupport: () => true, checkBwrapMountIsolationSupport: () => true,
}));
const { WorkerManager } = await import('../../src/workers');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** `feature` and `main` both changed only `bun.lock`; both pushed to a bare origin. */
function lockOnlyConflict(): { dir: string; remote: string } {
  const dir = mkdtempSync(join(tmpdir(), 'derived-no-agent-'));
  const remote = mkdtempSync(join(tmpdir(), 'derived-no-agent-remote-'));
  dirs.push(dir, remote);
  git(remote, 'init', '-q', '--bare');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'bun.lock'), 'lock v0\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feature');
  writeFileSync(join(dir, 'bun.lock'), 'lock feature\n');
  git(dir, 'commit', '-qam', 'feature');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'bun.lock'), 'lock main\n');
  git(dir, 'commit', '-qam', 'main');
  git(dir, 'checkout', '-q', 'feature');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main', 'feature');
  git(dir, 'fetch', '-q', 'origin');
  return { dir, remote };
}

function manager() {
  const m = Object.create(WorkerManager.prototype) as any;
  const updates: any[] = [];
  const milestones: any[] = [];
  Object.assign(m, {
    workers: new Map(), workerTeamKeys: new Map(), credCache: new Map(),
    config: {},
    buildd: { updateWorker: mock(async (_id: string, u: any) => { updates.push(u); return u.branch ? { branch: u.branch } : {}; }) },
    sendHeartbeat: () => {}, emit: () => {}, addMilestone: (w: any, ms: any) => { milestones.push(ms); w.milestones?.push(ms); },
    pusherManager: { subscribeToWorker: () => {} },
    startSession: mock(async () => {}),
  });
  return { m, updates, milestones };
}

function task(context: Record<string, unknown> = {}) {
  return {
    id: 'task-retry', title: 'Resolve conflicts', workspaceId: 'ws',
    context: { resumeBranch: 'feature', baseBranch: 'main', failureContext: { errorType: 'merge_conflict' }, ...context },
    workspace: {
      name: 'Example', repo: 'https://github.com/example/repo',
      gitConfig: { defaultBranch: 'main', derivedFiles: [{ glob: 'bun.lock', regenerate: 'printf "lock regenerated\\n" > bun.lock' }] },
    },
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 25));
  expect(cond()).toBe(true);
}

describe('derived-only conflict retry finished without an agent', () => {
  test('verifies, pushes and completes; startSession never runs', async () => {
    const { dir, remote } = lockOnlyConflict();
    setupPath = dir;
    const { m, updates } = manager();
    await m.startFromClaim({ id: 'w1', branch: 'feature' }, task({ verificationCommand: 'grep -q regenerated bun.lock' }), dir);
    await until(() => updates.some(u => u.status === 'completed'));

    expect(m.startSession).not.toHaveBeenCalled();
    const head = git(dir, 'rev-parse', 'HEAD');
    expect(git(remote, 'rev-parse', 'refs/heads/feature')).toBe(head);
    const done = updates.find(u => u.status === 'completed');
    expect(done.summary).toContain('printf "lock regenerated\\n" > bun.lock');
    expect(done.summary).toContain('grep -q regenerated bun.lock');
    expect(done.derivedMergeFinish).toEqual({
      baseRef: 'origin/main',
      regenerated: ['printf "lock regenerated\\n" > bun.lock'],
      verification: 'grep -q regenerated bun.lock',
      headSha: head,
    });
    expect(m.workers.get('w1').status).toBe('done');
  });

  test('a failing verification starts the agent with the note, and pushes nothing', async () => {
    const { dir, remote } = lockOnlyConflict();
    setupPath = dir;
    const remoteBefore = git(remote, 'rev-parse', 'refs/heads/feature');
    const { m, updates } = manager();
    await m.startFromClaim({ id: 'w2', branch: 'feature' }, task({ verificationCommand: 'echo nope >&2; exit 1' }), dir);
    await until(() => m.startSession.mock.calls.length > 0);

    expect(updates.some(u => u.status === 'completed')).toBe(false);
    expect(git(remote, 'rev-parse', 'refs/heads/feature')).toBe(remoteBefore);
    const note: string = m.workers.get('w2').derivedMergeNote;
    expect(note).toContain('Base already merged');
    expect(note).toContain('nope');
  });

  test('a refused completion hands the already-pushed merge to the agent', async () => {
    const { dir } = lockOnlyConflict();
    setupPath = dir;
    const { m } = manager();
    m.buildd.updateWorker = mock(async (_id: string, u: any) => {
      if (u.status === 'completed') throw new Error('API error: 400 - requires a pull request');
      return u.branch ? { branch: u.branch } : {};
    });
    await m.startFromClaim({ id: 'w3', branch: 'feature' }, task(), dir);
    await until(() => m.startSession.mock.calls.length > 0);
    expect(m.workers.get('w3').derivedMergeNote).toContain('already pushed');
  });

  test('a loop task is left to the agent', async () => {
    const { dir, remote } = lockOnlyConflict();
    setupPath = dir;
    const remoteBefore = git(remote, 'rev-parse', 'refs/heads/feature');
    const { m } = manager();
    await m.startFromClaim({ id: 'w4', branch: 'feature' }, { ...task(), loopConfig: { exitCondition: { type: 'pr_checks_green' } } }, dir);
    await until(() => m.startSession.mock.calls.length > 0);
    expect(git(remote, 'rev-parse', 'refs/heads/feature')).toBe(remoteBefore);
  });
});
