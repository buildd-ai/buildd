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
  test('removes a pushed, clean worktree without archiving', async () => {
    const path = makeWorktree('pushed', { push: true, commit: true });
    const res = await sweepTerminalWorktrees({ records: [record('pushed', path)], inMemoryWorkers: [], now: Date.now(), retentionMs: 0, archiveDir });

    expect(existsSync(path)).toBe(false);
    expect(res).toEqual([{ id: 'pushed', outcome: 'removed' }]);
    expect(existsSync(archiveDir) ? readdirSync(archiveDir) : []).toEqual([]);
  });

  test('bundles unpushed commits before removing, and the bundle holds them', async () => {
    const path = makeWorktree('unpushed', { push: false, commit: true });
    const sha = git(path, 'rev-parse HEAD').trim();
    const res = await sweepTerminalWorktrees({ records: [record('unpushed', path, { status: 'error' })], inMemoryWorkers: [], now: Date.now(), retentionMs: 0, archiveDir });

    expect(res[0].outcome).toBe('archived');
    expect(existsSync(path)).toBe(false);
    const bundle = join(archiveDir, 'unpushed.bundle');
    expect(existsSync(bundle)).toBe(true);
    expect(git(repo, `bundle list-heads "${bundle}"`)).toContain(sha);
    // The branch ref itself survives worktree removal as well.
    expect(git(repo, 'branch --list buildd/unpushed')).toContain('buildd/unpushed');
  });

  test('saves tracked uncommitted edits as a patch before removing', async () => {
    const path = makeWorktree('dirty', { push: true, commit: true, dirty: true });
    const res = await sweepTerminalWorktrees({ records: [record('dirty', path)], inMemoryWorkers: [], now: Date.now(), retentionMs: 0, archiveDir });

    expect(res[0].outcome).toBe('archived');
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(archiveDir, 'dirty.patch'), 'utf-8')).toContain('edited but not committed');
  });

  test('keeps the worktree when the archive cannot be written', async () => {
    const path = makeWorktree('noarchive', { push: false, commit: true });
    mkdirSync(archiveDir, { recursive: true });
    chmodSync(archiveDir, 0o500);
    try {
      const res = await sweepTerminalWorktrees({ records: [record('noarchive', path)], inMemoryWorkers: [], now: Date.now(), retentionMs: 0, archiveDir });
      expect(res[0].outcome).toBe('kept');
      expect(existsSync(path)).toBe(true);
    } finally {
      chmodSync(archiveDir, 0o700);
    }
  });

  // An agent's brand-new source file that was never `git add`ed is work too.
  // `git diff HEAD` does not see it, so it used to be deleted with the tree.
  test('saves untracked, non-ignored files in the patch before removing', async () => {
    const path = makeWorktree('newfile', { push: false, commit: false });
    writeFileSync(join(path, '.gitignore'), 'node_modules/\n');
    git(path, 'add .gitignore');
    git(path, 'commit -q -m ignore');
    git(path, 'push -q origin buildd/newfile');
    writeFileSync(join(path, 'newfeature.ts'), 'export const brandNew = 1;\n');
    mkdirSync(join(path, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(path, 'node_modules', 'dep', 'index.js'), 'ignored build output\n');

    const res = await sweepTerminalWorktrees({ records: [record('newfile', path)], inMemoryWorkers: [], now: Date.now(), retentionMs: 0, archiveDir });

    expect(res[0].outcome).toBe('archived');
    expect(existsSync(path)).toBe(false);
    const patch = readFileSync(join(archiveDir, 'newfile.patch'), 'utf-8');
    expect(patch).toContain('newfeature.ts');
    expect(patch).toContain('brandNew');
    expect(patch).not.toContain('ignored build output');
    // The patch applies cleanly back onto the pushed branch.
    const check = join(root, 'check');
    git(repo, `worktree add -q "${check}" origin/buildd/newfile`);
    git(check, `apply "${join(archiveDir, 'newfile.patch')}"`);
    expect(readFileSync(join(check, 'newfeature.ts'), 'utf-8')).toContain('brandNew');
  });

  test('an untracked file alone makes an otherwise pushed-clean tree archive, not remove', async () => {
    const path = makeWorktree('onlynew', { push: true, commit: true });
    writeFileSync(join(path, 'fresh.ts'), 'new\n');
    const res = await sweepTerminalWorktrees({ records: [record('onlynew', path)], inMemoryWorkers: [], now: Date.now(), retentionMs: 0, archiveDir });
    expect(res[0].outcome).toBe('archived');
    expect(readFileSync(join(archiveDir, 'onlynew.patch'), 'utf-8')).toContain('fresh.ts');
  });

  // A done/error worker still in memory is inside its resume retention window:
  // a follow-up message resumes in this tree. Eviction owns it, not the sweep.
  test('skips a path owned by an in-memory worker of any status', async () => {
    const path = makeWorktree('resumable', { push: true, commit: true });
    const res = await sweepTerminalWorktrees({
      records: [record('resumable', path)],
      inMemoryWorkers: [['w-done-in-memory', { worktreePath: path, status: 'done' }]],
      now: Date.now(), retentionMs: 0, archiveDir,
    });
    expect(res).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  // setupWorktree creates the directory, then runs a dependency install
  // before the worker's worktreePath is set. A branch-keyed path can be the
  // one an old record points at; the sweep must not remove it mid-install.
  test('skips every record in a repo with a worktree setup in flight', async () => {
    const path = makeWorktree('inflight', { push: true, commit: true });
    const res = await sweepTerminalWorktrees({
      records: [record('inflight', path)],
      inMemoryWorkers: [],
      busyRepos: new Set([repo]),
      now: Date.now(), retentionMs: 0, archiveDir,
    });
    expect(res).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  test('handles at most maxPerPass worktrees per pass', async () => {
    const a = makeWorktree('cap-a', { push: true, commit: true });
    const b = makeWorktree('cap-b', { push: true, commit: true });
    const res = await sweepTerminalWorktrees({
      records: [record('cap-a', a), record('cap-b', b)],
      inMemoryWorkers: [], now: Date.now(), retentionMs: 0, archiveDir, maxPerPass: 1,
    });
    expect(res).toEqual([{ id: 'cap-a', outcome: 'removed' }]);
    expect(existsSync(b)).toBe(true);
  });

  test('skips records the caller already saw kept', async () => {
    const path = makeWorktree('seen-kept', { push: false, commit: true });
    const res = await sweepTerminalWorktrees({
      records: [record('seen-kept', path)],
      inMemoryWorkers: [], skipIds: new Set(['seen-kept']),
      now: Date.now(), retentionMs: 0, archiveDir,
    });
    expect(res).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  test('skips a path a live worker now owns', async () => {
    const path = makeWorktree('shared', { push: false, commit: true });
    const res = await sweepTerminalWorktrees({
      records: [record('shared', path)],
      inMemoryWorkers: [['w-live', { worktreePath: path, status: 'working' }]],
      now: Date.now(), retentionMs: 0, archiveDir,
    });
    expect(res).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  test('honours the retention window, like eviction', async () => {
    const path = makeWorktree('recent', { push: true, commit: true });
    const res = await sweepTerminalWorktrees({ records: [record('recent', path, { lastActivity: Date.now() })], inMemoryWorkers: [], now: Date.now(), retentionMs: 10 * 60 * 1000, archiveDir });
    expect(res).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  test('ignores non-terminal records and paths outside the runner worktree dir', async () => {
    const path = makeWorktree('waiting', { push: true, commit: true });
    const res = await sweepTerminalWorktrees({
      records: [
        record('waiting', path, { status: 'waiting' }),
        record('foreign', repo),
      ],
      inMemoryWorkers: [], now: Date.now(), retentionMs: 0, archiveDir,
    });
    expect(res).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(repo)).toBe(true);
  });

  test('reports a record whose worktree is already gone, so the caller can clear it', async () => {
    const res = await sweepTerminalWorktrees({ records: [record('gone', join(repo, '.buildd-worktrees', 'gone'))], inMemoryWorkers: [], now: Date.now(), retentionMs: 0, archiveDir });
    expect(res).toEqual([{ id: 'gone', outcome: 'missing' }]);
  });
});
