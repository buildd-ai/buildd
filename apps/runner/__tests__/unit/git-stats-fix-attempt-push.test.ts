/**
 * collectGitStats on a fix attempt that pushed to its own PR branch.
 *
 * A fix or resume attempt's worktree base is the PR's branch itself
 * (`origin/buildd/<id>-...`). Measured against that ref, an attempt that
 * pushed reads as a 0-file diff: after the push origin/<branch> IS HEAD, so the
 * merge-base is HEAD. The server then flagged `pushed_without_diff` on fixes
 * that had pushed real commits. Stats now measure from the commit the base held
 * at setup (`baseSha`). Real git repos, no mocks.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { collectGitStats } = require('../../src/git-operations');

const BRANCH = 'buildd/abc12345-fix-thing';
const BASE_REF = `origin/${BRANCH}`;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

let root: string;
let origin: string;
let seed: string;
let work: string;

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, env: GIT_ENV, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function commitFile(cwd: string, file: string, body: string, msg: string): void {
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), body);
  git(cwd, `add "${file}"`);
  git(cwd, `commit -q -m "${msg}"`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'git-stats-fix-'));
  origin = join(root, 'origin.git');
  seed = join(root, 'seed');
  work = join(root, 'work');
  execSync(`git init -q --bare -b dev "${origin}"`, { env: GIT_ENV });
  execSync(`git clone -q "${origin}" "${seed}"`, { env: GIT_ENV, stdio: 'pipe' });
  git(seed, 'checkout -q -b dev');
  commitFile(seed, 'README.md', 'hello\n', 'init');
  git(seed, 'push -q origin dev');
  // The PR: a prior attempt's commit, already on origin.
  git(seed, `checkout -q -b ${BRANCH}`);
  commitFile(seed, 'src/a.ts', 'export const a = 1;\n', 'first attempt');
  git(seed, `push -q origin ${BRANCH}`);

  // The fix attempt's worktree: checked out on the PR branch, cut from it.
  execSync(`git clone -q "${origin}" "${work}"`, { env: GIT_ENV, stdio: 'pipe' });
  git(work, `checkout -q -B ${BRANCH} ${BASE_REF}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** What setupWorktree pins: the commit the base ref held when the worktree was cut. */
function setupBaseSha(): string {
  return git(work, `rev-parse ${BASE_REF}`);
}

describe('collectGitStats: a fix attempt that pushed to its PR branch', () => {
  test('a pushed normal commit is counted, not read as a 0-file diff', async () => {
    const baseSha = setupBaseSha();
    commitFile(work, 'src/a.ts', 'export const a = 2;\nexport const b = 3;\n', 'fix');
    git(work, `push -q origin ${BRANCH}`);

    const stats = await collectGitStats(work, 'w-fix', 0, BASE_REF, baseSha);
    expect(stats.filesChanged).toBe(1);
    expect(stats.linesAdded).toBe(2);
    expect(stats.commitCount).toBe(1);
    expect(stats.lastCommitSha).toBe(git(work, 'rev-parse HEAD'));

    // Without the pinned commit the same push reads as nothing at all.
    const unpinned = await collectGitStats(work, 'w-fix', 0, BASE_REF);
    expect(unpinned.filesChanged).toBe(0);
  });

  test('a pushed pure merge commit (dev merged in) is counted', async () => {
    const baseSha = setupBaseSha();
    git(seed, 'checkout -q dev');
    commitFile(seed, 'src/dev.ts', 'export const d = 1;\n', 'dev moves on');
    git(seed, 'push -q origin dev');

    git(work, 'fetch -q origin');
    git(work, 'merge -q --no-ff --no-edit origin/dev');
    git(work, `push -q origin ${BRANCH}`);

    const stats = await collectGitStats(work, 'w-merge', 0, BASE_REF, baseSha);
    expect(stats.filesChanged).toBeGreaterThan(0);
    expect(stats.commitCount).toBeGreaterThan(0);
    expect(stats.lastCommitSha).toBe(git(work, 'rev-parse HEAD'));
  });

  test('a salvage continuation counts its own push, not the checkpoint it started from', async () => {
    // The checkpoint a prior worker pushed is the continuation's baseline.
    git(seed, `checkout -q ${BRANCH}`);
    commitFile(seed, 'src/checkpoint.ts', 'export const c = 1;\n', 'checkpoint');
    git(seed, `push -q origin ${BRANCH}`);
    git(work, 'fetch -q origin');
    git(work, `checkout -q -B ${BRANCH} ${BASE_REF}`);
    const baseSha = setupBaseSha();

    commitFile(work, 'packages/core/drizzle/20261024000000_x/migration.sql', 'ALTER TABLE t ADD c int;\n', 'regenerate migration');
    git(work, `push -q origin ${BRANCH}`);

    const stats = await collectGitStats(work, 'w-salvage', 0, BASE_REF, baseSha);
    expect(stats.filesChanged).toBe(1);
    expect(stats.commitCount).toBe(1);
    expect(stats.lastCommitSha).toBe(git(work, 'rev-parse HEAD'));
  });

  test('an attempt that pushed nothing still reads as no diff', async () => {
    const baseSha = setupBaseSha();
    const stats = await collectGitStats(work, 'w-noop', 0, BASE_REF, baseSha);
    expect(stats.filesChanged).toBe(0);
    expect(stats.commitCount).toBe(0);
    expect(stats.lastCommitSha).toBeUndefined();
  });

  test('a trunk base keeps the moving ref: merging dev in does not count its commits', async () => {
    const trunk = join(root, 'trunk');
    execSync(`git clone -q "${origin}" "${trunk}"`, { env: GIT_ENV, stdio: 'pipe' });
    git(trunk, 'checkout -q -B buildd/def67890-feature origin/dev');
    const baseSha = git(trunk, 'rev-parse origin/dev');
    commitFile(trunk, 'src/feature.ts', 'export const f = 1;\n', 'feature');

    git(seed, 'checkout -q dev');
    commitFile(seed, 'src/dev.ts', 'export const d = 1;\n', 'dev moves on');
    git(seed, 'push -q origin dev');
    git(trunk, 'fetch -q origin');
    git(trunk, 'merge -q --no-edit origin/dev');

    const stats = await collectGitStats(trunk, 'w-trunk', 0, 'origin/dev', baseSha);
    expect(stats.filesChanged).toBe(1);
  });
});
