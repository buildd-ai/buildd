/**
 * Regression guards for the doctor's git self-heal.
 *
 * git-branch: "N commits behind origin" used to be `fixable`, and its fixer ran
 * `checkout -f && reset --hard origin/<branch>` from the 30-minute self-heal —
 * an update path with no idle gate, no `bun install` and no health probe, so a
 * running process could end up on a new tree. Moving the install is the gated
 * updater's job (updater.ts `applyUpdate`); the doctor only reports.
 *
 * git-clean: the check counted untracked (`??`) entries, but the fix only
 * restores tracked files, so an untracked file re-triggered the fix every cycle
 * forever. And the fix never said which tracked files it discarded.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/doctor-git-selfheal.test.ts
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'buildd-doctor-git-'));
const origin = join(root, 'origin.git');
const home = join(root, 'home');
const upstream = join(root, 'upstream');

const injectedHome = process.env.BUILDD_HOME;
const injectedBranch = process.env.BUILDD_BRANCH;
process.env.BUILDD_HOME = home;
process.env.BUILDD_BRANCH = 'main';

const git = (cwd: string, cmd: string) =>
  execSync(`git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false ${cmd}`, {
    cwd, encoding: 'utf-8', stdio: 'pipe',
  }).trim();

execSync(`git init -q --bare -b main "${origin}"`);
execSync(`git clone -q "${origin}" "${upstream}"`);
git(upstream, 'checkout -q -B main');
mkdirSync(join(upstream, 'apps'), { recursive: true });
writeFileSync(join(upstream, 'apps', 'tracked.ts'), 'original\n');
mkdirSync(join(upstream, 'packages'), { recursive: true });
writeFileSync(join(upstream, 'packages', 'keep.ts'), 'x\n');
git(upstream, 'add -A');
git(upstream, 'commit -q -m init');
git(upstream, 'push -q origin main');
execSync(`git clone -q "${origin}" "${home}"`);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const doctor = require('../../src/doctor');

afterAll(() => {
  if (injectedHome === undefined) delete process.env.BUILDD_HOME;
  else process.env.BUILDD_HOME = injectedHome;
  if (injectedBranch === undefined) delete process.env.BUILDD_BRANCH;
  else process.env.BUILDD_BRANCH = injectedBranch;
  rmSync(root, { recursive: true, force: true });
});

function reportOf(check: any) {
  return { timestamp: '', checks: [check], summary: { ok: 0, warn: 1, error: 0 } };
}

describe('git-branch self-heal', () => {
  test('behind origin is reported but not fixable, and autoFix never resets the tree', () => {
    writeFileSync(join(upstream, 'apps', 'tracked.ts'), 'upstream change\n');
    git(upstream, 'commit -q -am next');
    git(upstream, 'push -q origin main');
    git(home, 'fetch -q origin main');
    const before = git(home, 'rev-parse HEAD');

    const check = doctor.checkGitState();
    expect(check.name).toBe('git-branch');
    expect(check.status).toBe('warn');
    expect(check.message).toContain('behind');
    expect(check.fixable).toBeFalsy();

    // Even a report that (wrongly) marks it fixable must not move the tree.
    const fixes = doctor.autoFix(reportOf({ ...check, fixable: true }));
    expect(fixes.map((f: any) => f.check)).not.toContain('git-branch');
    expect(git(home, 'rev-parse HEAD')).toBe(before);
  });

  test('wrong branch is reported but not fixable', () => {
    git(home, 'checkout -q -b side');
    try {
      const check = doctor.checkGitState();
      expect(check.status).toBe('error');
      expect(check.fixable).toBeFalsy();
    } finally {
      git(home, 'checkout -q main');
    }
  });
});

describe('git-clean self-heal', () => {
  test('an untracked file alone does not trigger the fix', () => {
    writeFileSync(join(home, 'apps', 'untracked.ts'), 'scratch\n');
    try {
      const check = doctor.checkGitDirty();
      expect(check.status).toBe('ok');
      expect(check.fixable).toBeFalsy();
    } finally {
      rmSync(join(home, 'apps', 'untracked.ts'), { force: true });
    }
  });

  test('a tracked edit is fixable and the fix names the discarded file', () => {
    writeFileSync(join(home, 'apps', 'tracked.ts'), 'local edit\n');
    const check = doctor.checkGitDirty();
    expect(check.status).toBe('warn');
    expect(check.fixable).toBe(true);
    expect(check.message).toContain('1 tracked file');

    const [fix] = doctor.autoFix(reportOf(check));
    expect(fix.check).toBe('git-clean');
    expect(fix.success).toBe(true);
    expect(fix.message).toContain('apps/tracked.ts');
    expect(readFileSync(join(home, 'apps', 'tracked.ts'), 'utf-8')).not.toBe('local edit\n');
  });
});
