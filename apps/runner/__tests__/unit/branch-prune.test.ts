/**
 * pruneLocalBranches: stale `buildd/*` branches are deleted (with their
 * `.git/config` sections); live-worktree, protected and unpushed-unmerged
 * branches survive; seed worktree registrations are dropped.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/branch-prune.test.ts
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pruneLocalBranches } from '../../src/branch-prune';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const git = (cwd: string, cmd: string) =>
  execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

let root: string;
let repo: string;
let origin: string;

const branches = () => git(repo, "for-each-ref --format='%(refname:short)' refs/heads/buildd/").split('\n').filter(Boolean).sort();
const config = () => readFileSync(join(repo, '.git', 'config'), 'utf-8');

function commitOn(name: string, base = 'origin/main') {
  git(repo, `branch ${name} ${base}`);
  const wt = mkdtempSync(join(root, 'tmpwt-'));
  rmSync(wt, { recursive: true });
  git(repo, `worktree add -q "${wt}" ${name}`);
  writeFileSync(join(wt, `${name.replace(/\//g, '_')}.txt`), 'x\n');
  git(wt, 'add -A');
  git(wt, 'commit -q -m work');
  git(repo, `worktree remove --force "${wt}"`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'branch-prune-'));
  roots.push(root);
  origin = join(root, 'origin.git');
  git(root, `init -q --bare -b main "${origin}"`);
  repo = join(root, 'clone');
  git(root, `clone -q "${origin}" "${repo}"`);
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add -A');
  git(repo, 'commit -q -m init');
  git(repo, 'push -q origin HEAD:main');
  git(repo, 'fetch -q origin');
});

describe('pruneLocalBranches', () => {
  test('deletes merged and remote-gone branches, keeps live, protected and unpushed ones', () => {
    for (let i = 0; i < 5; i++) git(repo, `branch buildd/merged${i} origin/main`);
    commitOn('buildd/gone');
    git(repo, 'push -q -u origin buildd/gone');
    git(repo, 'push -q origin --delete buildd/gone');
    git(repo, 'fetch -q --prune origin');
    git(repo, `worktree add -q -b buildd/live "${join(repo, '.buildd-worktrees', 'live')}" origin/main`);
    commitOn('buildd/protected');
    commitOn('buildd/unpushed');
    git(repo, 'config branch.buildd/unpushed.remote origin');

    const res = pruneLocalBranches(repo, { protectedBranches: ['buildd/protected'], seedDir: join(root, 'no-seed') });

    // 5 merged + gone + (live is merged but checked out → kept)
    expect(res.branchesPruned).toBe(6);
    expect(branches()).toEqual(['buildd/live', 'buildd/protected', 'buildd/unpushed']);
    const cfg = config();
    expect(cfg).not.toContain('merged');
    expect(cfg).not.toContain('"buildd/gone"');
    expect(cfg).toContain('buildd/unpushed');
  });

  test('a branch whose tip a remote ref holds is dropped at any age; local-only work is kept', () => {
    commitOn('buildd/pushed');
    git(repo, 'push -q -u origin buildd/pushed');
    commitOn('buildd/local');
    const res = pruneLocalBranches(repo, { seedDir: join(root, 'no-seed') });
    expect(res.branchesPruned).toBe(1);
    expect(branches()).toEqual(['buildd/local']);
  });

  // Runner branches are created with their BASE as upstream (origin/dev), so
  // `[gone]` never fires and the branch's own remote ref is often absent.
  test('upstream = base: dropped when its commits sit on any remote ref under another name', () => {
    commitOn('buildd/base-upstream');
    git(repo, 'branch --set-upstream-to=origin/main buildd/base-upstream');
    git(repo, 'push -q origin buildd/base-upstream:refs/heads/mission/integration');
    git(repo, 'fetch -q origin');
    commitOn('buildd/base-upstream-local');
    git(repo, 'branch --set-upstream-to=origin/main buildd/base-upstream-local');
    const res = pruneLocalBranches(repo, { seedDir: join(root, 'no-seed') });
    expect(res.branchesPruned).toBe(1);
    expect(branches()).toEqual(['buildd/base-upstream-local']);
    expect(config()).not.toContain('"buildd/base-upstream"');
  });

  test('tip equal to a PR head on the remote is dropped; a commit on top of it is kept', () => {
    commitOn('buildd/pr-closed');
    git(repo, 'push -q origin buildd/pr-closed:refs/pull/7/head');
    commitOn('buildd/pr-ahead');
    git(repo, 'push -q origin buildd/pr-ahead:refs/pull/8/head');
    const wt = join(root, 'wt-ahead');
    git(repo, `worktree add -q "${wt}" buildd/pr-ahead`);
    writeFileSync(join(wt, 'more.txt'), 'y\n');
    git(wt, 'add -A');
    git(wt, 'commit -q -m more');
    git(repo, `worktree remove --force "${wt}"`);
    // refs/pull/* is not in the default fetch refspec: only ls-remote sees it.
    expect(git(repo, 'for-each-ref refs/remotes/')).not.toContain('pull');
    const res = pruneLocalBranches(repo, { seedDir: join(root, 'no-seed') });
    expect(res.branchesPruned).toBe(1);
    expect(branches()).toEqual(['buildd/pr-ahead']);
  });

  test('0 commits ahead of a local upstream is dropped', () => {
    commitOn('feature');
    git(repo, 'branch -q --track buildd/tracks-feature feature');
    const res = pruneLocalBranches(repo, { seedDir: join(root, 'no-seed') });
    expect(res.branchesPruned).toBe(1);
    expect(branches()).toEqual([]);
  });

  test('unreachable remote: the PR-head rule is skipped, nothing throws, other rules still run', () => {
    commitOn('buildd/pr-only');
    git(repo, 'push -q origin buildd/pr-only:refs/pull/9/head');
    git(repo, 'branch buildd/merged origin/main');
    git(repo, `remote set-url origin "${join(root, 'missing.git')}"`);
    const res = pruneLocalBranches(repo, { seedDir: join(root, 'no-seed') });
    expect(res.branchesPruned).toBe(1);
    expect(branches()).toEqual(['buildd/pr-only']);
  });

  test('bounds deletions per tick', () => {
    for (let i = 0; i < 7; i++) git(repo, `branch buildd/m${i} origin/main`);
    const res = pruneLocalBranches(repo, { maxDeletes: 3, seedDir: join(root, 'no-seed') });
    expect(res.branchesPruned).toBe(3);
    expect(branches()).toHaveLength(4);
  });

  test('removes worktree registrations under the seed dir', () => {
    const seedDir = join(root, 'seed');
    git(repo, `worktree add -q --detach "${join(seedDir, 'a')}" origin/main`);
    git(repo, `worktree add -q --detach "${join(seedDir, 'b')}" origin/main`);
    const res = pruneLocalBranches(repo, { seedDir });
    expect(res.seedWorktreesRemoved).toBe(2);
    expect(existsSync(join(seedDir, 'a'))).toBe(false);
    expect(git(repo, 'worktree list --porcelain')).not.toContain(seedDir);
  });
});
