/**
 * Worktrees of workers that were already terminal before a restart leaked.
 *
 * `evictCompletedWorkers` is the only path that removes a terminal worker's
 * worktree, and it only walks workers in memory. `restoreWorkersFromDisk`
 * deliberately leaves already-terminal records on disk, so after a restart
 * nothing ever looked at their worktrees again — each one a full checkout plus
 * node_modules. The periodic sweep does not collect them either when the branch
 * is unpushed.
 *
 * `sweepTerminalWorktrees` walks the terminal records on disk: pushed and clean
 * → remove; unpushed commits or tracked edits → archive (bundle + patch), then
 * remove; archive failure → keep.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/terminal-worktree-sweep.test.ts
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sweepTerminalWorktrees, type SweepRecord } from '../../src/terminal-worktree-sweep';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const git = (cwd: string, cmd: string) =>
  execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

let root: string;
let repo: string;
let archiveDir: string;

function makeWorktree(name: string, opts: { push: boolean; commit: boolean; dirty?: boolean }) {
  const path = join(repo, '.buildd-worktrees', name);
  git(repo, `worktree add -b buildd/${name} "${path}" origin/main`);
  if (opts.commit) {
    writeFileSync(join(path, `${name}.txt`), 'work\n');
    git(path, 'add -A');
    git(path, `commit -m "work ${name}"`);
  }
  if (opts.push) git(path, `push -q origin buildd/${name}`);
  if (opts.dirty) writeFileSync(join(path, 'README.md'), 'edited but not committed\n');
  return path;
}

const OLD = Date.now() - 60 * 60 * 1000;

function record(id: string, path: string, over: Partial<SweepRecord> = {}): SweepRecord {
  return { id, status: 'done', worktreePath: path, branch: `buildd/${id}`, lastActivity: OLD, ...over };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'terminal-wt-sweep-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  git(root, `init -q --bare -b main "${origin}"`);
  repo = join(root, 'clone');
  git(root, `clone -q "${origin}" "${repo}"`);
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add -A');
  git(repo, 'commit -q -m init');
  git(repo, 'push -q origin HEAD:main');
  git(repo, 'fetch -q origin');
  archiveDir = join(root, 'archive');
});

describe('sweepTerminalWorktrees', () => {
  test('removes a pushed, clean worktree without archiving', () => {
    const path = makeWorktree('pushed', { push: true, commit: true });
    const res = sweepTerminalWorktrees({ records: [record('pushed', path)], liveWorkers: [], now: Date.now(), retentionMs: 0, archiveDir });

    expect(existsSync(path)).toBe(false);
    expect(res).toEqual([{ id: 'pushed', outcome: 'removed' }]);
    expect(existsSync(archiveDir) ? readdirSync(archiveDir) : []).toEqual([]);
  });

  test('bundles unpushed commits before removing, and the bundle holds them', () => {
    const path = makeWorktree('unpushed', { push: false, commit: true });
    const sha = git(path, 'rev-parse HEAD').trim();
    const res = sweepTerminalWorktrees({ records: [record('unpushed', path, { status: 'error' })], liveWorkers: [], now: Date.now(), retentionMs: 0, archiveDir });

    expect(res[0].outcome).toBe('archived');
    expect(existsSync(path)).toBe(false);
    const bundle = join(archiveDir, 'unpushed.bundle');
    expect(existsSync(bundle)).toBe(true);
    expect(git(repo, `bundle list-heads "${bundle}"`)).toContain(sha);
    // The branch ref itself survives worktree removal as well.
    expect(git(repo, 'branch --list buildd/unpushed')).toContain('buildd/unpushed');
  });

  test('saves tracked uncommitted edits as a patch before removing', () => {
    const path = makeWorktree('dirty', { push: true, commit: true, dirty: true });
    const res = sweepTerminalWorktrees({ records: [record('dirty', path)], liveWorkers: [], now: Date.now(), retentionMs: 0, archiveDir });

    expect(res[0].outcome).toBe('archived');
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(archiveDir, 'dirty.patch'), 'utf-8')).toContain('edited but not committed');
  });

  test('keeps the worktree when the archive cannot be written', () => {
    const path = makeWorktree('noarchive', { push: false, commit: true });
    mkdirSync(archiveDir, { recursive: true });
    chmodSync(archiveDir, 0o500);
    try {
      const res = sweepTerminalWorktrees({ records: [record('noarchive', path)], liveWorkers: [], now: Date.now(), retentionMs: 0, archiveDir });
      expect(res[0].outcome).toBe('kept');
      expect(existsSync(path)).toBe(true);
    } finally {
      chmodSync(archiveDir, 0o700);
    }
  });

  test('skips a path a live worker now owns', () => {
    const path = makeWorktree('shared', { push: false, commit: true });
    const res = sweepTerminalWorktrees({
      records: [record('shared', path)],
      liveWorkers: [['w-live', { worktreePath: path, status: 'working' }]],
      now: Date.now(), retentionMs: 0, archiveDir,
    });
    expect(res).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  test('honours the retention window, like eviction', () => {
    const path = makeWorktree('recent', { push: true, commit: true });
    const res = sweepTerminalWorktrees({ records: [record('recent', path, { lastActivity: Date.now() })], liveWorkers: [], now: Date.now(), retentionMs: 10 * 60 * 1000, archiveDir });
    expect(res).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  test('ignores non-terminal records and paths outside the runner worktree dir', () => {
    const path = makeWorktree('waiting', { push: true, commit: true });
    const res = sweepTerminalWorktrees({
      records: [
        record('waiting', path, { status: 'waiting' }),
        record('foreign', repo),
      ],
      liveWorkers: [], now: Date.now(), retentionMs: 0, archiveDir,
    });
    expect(res).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(repo)).toBe(true);
  });

  test('reports a record whose worktree is already gone, so the caller can clear it', () => {
    const res = sweepTerminalWorktrees({ records: [record('gone', join(repo, '.buildd-worktrees', 'gone'))], liveWorkers: [], now: Date.now(), retentionMs: 0, archiveDir });
    expect(res).toEqual([{ id: 'gone', outcome: 'missing' }]);
  });
});
