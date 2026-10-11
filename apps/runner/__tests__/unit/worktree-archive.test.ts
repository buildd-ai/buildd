/**
 * Archive-before-remove + checkpoint-on-abnormal-termination.
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worktree-archive.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkpointWorktree } from '../../src/worktree-archive';
import { removeWorktreeIfUnowned } from '../../src/git-operations';
import { buildRetryContinuitySection } from '../../src/worktree-utils';

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf-8' }).trim();

let root: string, origin: string, repo: string, wt: string, archiveDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-archive-')));
  origin = join(root, 'origin.git');
  repo = join(root, 'repo');
  archiveDir = join(root, 'archive');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-m', 'base'); g(repo, 'push', 'origin', 'HEAD:main');
  wt = join(repo, '.buildd-worktrees', 'task-branch');
  g(repo, 'worktree', 'add', '-b', 'task-branch', wt);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const dirty = () => {
  writeFileSync(join(wt, 'a.txt'), 'edited\n');
  writeFileSync(join(wt, 'new.txt'), 'untracked\n');
};
const removeOpts = (extra = {}) => ({
  repoPath: repo, worktreePath: wt, workerId: 'w1', workers: [] as any, archiveDir, ...extra,
});

describe('removeWorktreeIfUnowned archives first', () => {
  test('dirty tree: patch (tracked + untracked) written, then tree removed', async () => {
    dirty();
    const out = await removeWorktreeIfUnowned(removeOpts());
    expect(out).toEqual({ removed: true });
    expect(existsSync(wt)).toBe(false);
    const patch = readFileSync(join(archiveDir, 'w1.patch'), 'utf-8');
    expect(patch).toContain('edited');
    expect(patch).toContain('new.txt');
  });

  test('clean pushed tree: removed, nothing archived', async () => {
    const out = await removeWorktreeIfUnowned(removeOpts());
    expect(out).toEqual({ removed: true });
    expect(existsSync(join(archiveDir, 'w1.patch'))).toBe(false);
  });

  test('archive write failure: tree kept', async () => {
    dirty();
    writeFileSync(join(root, 'blocker'), 'file');
    const out = await removeWorktreeIfUnowned(removeOpts({ archiveDir: join(root, 'blocker', 'sub') }));
    expect(out).toEqual({ removed: false, reason: 'archive_failed' });
    expect(existsSync(join(wt, 'new.txt'))).toBe(true);
  });
});

describe('checkpointWorktree', () => {
  test('dirty tree: WIP commit pushed to the task branch and recorded', async () => {
    dirty();
    const cp = await checkpointWorktree({ worktreePath: wt, branch: 'task-branch', workerId: 'w1abcdef', reason: 'usage limit', archiveDir });
    expect(cp.kind).toBe('pushed');
    if (cp.kind !== 'pushed') return;
    expect(cp.ref).toBe(`origin/task-branch@${cp.sha}`);
    expect(g(origin, 'rev-parse', 'task-branch')).toBe(cp.sha);
    expect(g(origin, 'show', 'task-branch:new.txt')).toBe('untracked');
  });

  test('push impossible: falls back to bundle archive', async () => {
    dirty();
    g(wt, 'remote', 'set-url', 'origin', join(root, 'nonexistent.git'));
    const cp = await checkpointWorktree({ worktreePath: wt, branch: 'task-branch', workerId: 'w1abcdef', reason: 'usage limit', archiveDir });
    expect(cp.kind).toBe('archived');
    expect(existsSync(join(archiveDir, 'w1abcdef.bundle'))).toBe(true);
  });

  test('nothing to save: none', async () => {
    g(wt, 'push', 'origin', 'task-branch');
    const cp = await checkpointWorktree({ worktreePath: wt, branch: 'task-branch', workerId: 'w1', reason: 'x', archiveDir });
    expect(cp).toEqual({ kind: 'none' });
  });
});

describe('retry continuity', () => {
  test('prompt names the recovery ref', () => {
    const s = buildRetryContinuitySection({ resumeBranch: 'b', recoveryRef: 'origin/b@abc', defaultBranch: 'dev' });
    expect(s).toContain('origin/b@abc');
  });
  test('absent recoveryRef: unchanged', () => {
    expect(buildRetryContinuitySection({ resumeBranch: 'b', defaultBranch: 'dev' })).not.toContain('usage limit');
  });
});
