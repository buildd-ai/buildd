import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  bumpClass,
  nextVersion,
  compareSemver,
  parseReleaseTitle,
  planRefresh,
  renameChangelogVersion,
  tagSemverWarning,
} from './release-bump';

/**
 * A release PR's head is `dev`, so every merge after the cut lands in it — but
 * its title, package.json versions and CHANGELOG section were computed once, at
 * cut time. A `feat` merged after a patch cut therefore ships as a patch (and
 * Tag Release tags it as one, because it reads package.json). These pin the
 * recompute rules the refresh workflow and the tag-time warning share.
 */

const SCRIPT = join(import.meta.dir, 'release-bump.ts');

describe('bumpClass — the same rules scripts/release.sh uses', () => {
  test('fix/chore/docs only → patch', () => {
    expect(bumpClass(['fix: a', 'chore: bump version to v1.2.3', 'docs: b'])).toBe('patch');
  });
  test('any feat → minor, scoped or not', () => {
    expect(bumpClass(['fix: a', 'feat(pr-activity): b'])).toBe('minor');
    expect(bumpClass(['feat: b'])).toBe('minor');
  });
  test('a subject merely containing "feat" is not a feat', () => {
    expect(bumpClass(['fix: make feat flag work', 'defeat: x'])).toBe('patch');
  });
  test('BREAKING CHANGE or type! → major', () => {
    expect(bumpClass(['feat: a', 'fix!: drop old api'])).toBe('major');
    expect(bumpClass(['refactor: BREAKING CHANGE to config'])).toBe('major');
    expect(bumpClass(['refactor: breaking-change to config'])).toBe('major');
  });
  test('empty and blank input → patch', () => {
    expect(bumpClass([])).toBe('patch');
    expect(bumpClass(['', '  '])).toBe('patch');
  });
});

describe('semver helpers', () => {
  test('nextVersion resets lower components', () => {
    expect(nextVersion('0.221.0', 'patch')).toBe('0.221.1');
    expect(nextVersion('v0.221.1', 'minor')).toBe('0.222.0');
    expect(nextVersion('0.221.1', 'major')).toBe('1.0.0');
  });
  test('compareSemver is numeric, not lexical', () => {
    expect(compareSemver('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3', '1.3.0')).toBeLessThan(0);
  });
  test('parseReleaseTitle accepts only the generated shape', () => {
    expect(parseReleaseTitle('Release v0.221.1')).toBe('0.221.1');
    expect(parseReleaseTitle('Hotfix v0.221.1')).toBeNull();
    expect(parseReleaseTitle('Release v0.221.1 — hand edited')).toBeNull();
    expect(parseReleaseTitle('chore: release')).toBeNull();
  });
});

describe('planRefresh', () => {
  test('feat merged after a patch cut raises the PR to the next minor', () => {
    const plan = planRefresh({
      latestTag: 'v0.221.0',
      currentVersion: '0.221.1',
      subjects: ['fix: a', 'chore: bump version to v0.221.1', 'feat(x): b'],
    });
    expect(plan).toEqual({ bump: 'minor', required: '0.222.0', target: '0.222.0', raise: true });
  });
  test('nothing new that changes the class → no raise', () => {
    const plan = planRefresh({ latestTag: 'v0.221.0', currentVersion: '0.221.1', subjects: ['fix: a', 'fix: b'] });
    expect(plan.raise).toBe(false);
    expect(plan.target).toBe('0.221.1');
  });
  test('never downgrades a version someone deliberately raised', () => {
    const plan = planRefresh({ latestTag: 'v0.221.0', currentVersion: '0.222.0', subjects: ['fix: a'] });
    expect(plan).toMatchObject({ required: '0.221.1', target: '0.222.0', raise: false });
  });
  test('idempotent: re-running after the raise is a no-op', () => {
    const subjects = ['feat: b', 'chore: bump version to v0.222.0'];
    const first = planRefresh({ latestTag: 'v0.221.0', currentVersion: '0.221.1', subjects });
    const second = planRefresh({ latestTag: 'v0.221.0', currentVersion: first.target, subjects });
    expect(second.raise).toBe(false);
  });
});

describe('renameChangelogVersion', () => {
  const REPO = 'https://github.com/o/r';
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [0.221.1] - 2026-01-02',
    '',
    '- fix: a',
    '',
    '## [0.221.0] - 2026-01-01',
    '',
    '- fix: z',
    '',
    `[Unreleased]: ${REPO}/compare/v0.221.1...HEAD`,
    `[0.221.1]: ${REPO}/compare/v0.221.0...v0.221.1`,
    `[0.221.0]: ${REPO}/compare/v0.220.0...v0.221.0`,
    '',
  ].join('\n');

  test('renames the section header and both footer links, nothing else', () => {
    const out = renameChangelogVersion(changelog, '0.221.1', '0.222.0');
    expect(out).toContain('## [0.222.0] - 2026-01-02');
    expect(out).not.toContain('## [0.221.1]');
    expect(out).toContain(`[Unreleased]: ${REPO}/compare/v0.222.0...HEAD`);
    expect(out).toContain(`[0.222.0]: ${REPO}/compare/v0.221.0...v0.222.0`);
    // Prior release untouched.
    expect(out).toContain('## [0.221.0] - 2026-01-01');
    expect(out).toContain(`[0.221.0]: ${REPO}/compare/v0.220.0...v0.221.0`);
  });
  test('no section for the old version → unchanged', () => {
    expect(renameChangelogVersion(changelog, '0.300.0', '0.301.0')).toBe(changelog);
  });
  test('dots are literal, not regex wildcards', () => {
    const tricky = '## [0x221y1] - d\n';
    expect(renameChangelogVersion(tricky, '0.221.1', '0.222.0')).toBe(tricky);
  });
});

describe('tagSemverWarning', () => {
  test('a feat shipped as a patch is flagged, naming the commit', () => {
    const w = tagSemverWarning({ prevTag: 'v0.217.2', version: 'v0.217.3', subjects: ['fix: a', 'feat(ui): new thing'] });
    expect(w).not.toBeNull();
    expect(w).toContain('patch');
    expect(w).toContain('minor');
    expect(w).toContain('feat(ui): new thing');
  });
  test('correct or larger increments are silent', () => {
    expect(tagSemverWarning({ prevTag: 'v0.217.2', version: 'v0.218.0', subjects: ['feat: a'] })).toBeNull();
    expect(tagSemverWarning({ prevTag: 'v0.217.2', version: 'v0.217.3', subjects: ['fix: a'] })).toBeNull();
    expect(tagSemverWarning({ prevTag: 'v0.217.2', version: 'v0.218.0', subjects: ['fix: a'] })).toBeNull();
  });
  test('no previous tag → silent', () => {
    expect(tagSemverWarning({ prevTag: '', version: 'v0.1.0', subjects: ['feat!: x'] })).toBeNull();
  });
});

describe('CLI', () => {
  const run = (args: string[], opts: { cwd?: string; input?: string } = {}) =>
    spawnSync('bun', [SCRIPT, ...args], { cwd: opts.cwd, input: opts.input ?? '', encoding: 'utf8' });

  test('plan reads subjects from stdin and prints the plan as JSON', () => {
    const res = run(['plan', '--latest-tag', 'v0.221.0', '--current', '0.221.1'], { input: 'fix: a\nfeat: b\n' });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ bump: 'minor', required: '0.222.0', target: '0.222.0', raise: true });
  });

  test('apply rewrites every package file and the CHANGELOG section', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-bump-'));
    const pkgs = ['apps/web/package.json', 'packages/core/package.json'];
    for (const p of pkgs) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), JSON.stringify({ name: p, version: '0.221.1', private: true }, null, 2) + '\n');
    }
    writeFileSync(join(dir, 'CHANGELOG.md'), '## [Unreleased]\n\n## [0.221.1] - d\n\n- x\n');
    const res = run(['apply', '--from', '0.221.1', '--to', '0.222.0', '--package-files', pkgs.join(' ')], { cwd: dir });
    expect(res.status).toBe(0);
    for (const p of pkgs) {
      const json = JSON.parse(readFileSync(join(dir, p), 'utf8'));
      expect(json.version).toBe('0.222.0');
      expect(json.name).toBe(p);
    }
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toContain('## [0.222.0] - d');
  });

  test('apply refuses to touch a package file that is not at --from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-bump-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.100.0' }) + '\n');
    const res = run(['apply', '--from', '0.221.1', '--to', '0.222.0', '--package-files', 'package.json'], { cwd: dir });
    expect(res.status).not.toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('0.100.0');
  });

  test('check-tag prints a GitHub warning annotation and still exits 0', () => {
    const res = run(['check-tag', '--prev-tag', 'v0.217.2', '--version', 'v0.217.3'], { input: 'feat: x\n' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^::warning title=[^:]+::/m);
  });

  test('check-tag is silent when the increment is right', () => {
    const res = run(['check-tag', '--prev-tag', 'v0.217.2', '--version', 'v0.217.3'], { input: 'fix: x\n' });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('::warning');
  });
});

describe('release-tag.yml semver warning step', () => {
  const step = (): any => {
    const wf = Bun.YAML.parse(readFileSync('.github/workflows/release-tag.yml', 'utf8')) as any;
    const s = wf.jobs.tag.steps.find((x: any) => x.name === 'Warn on a semver under-bump');
    expect(s).toBeDefined();
    return s;
  };
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

  function repoWith(subjects: string[], tag: string) {
    const dir = mkdtempSync(join(tmpdir(), 'release-tag-semver-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t.test');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'initial');
    git(dir, 'tag', 'v1.2.0');
    for (const s of subjects) git(dir, 'commit', '-q', '--allow-empty', '-m', s);
    git(dir, 'tag', tag);
    return dir;
  }
  const runStep = (dir: string, version: string) =>
    spawnSync('bash', ['-c', step().run], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, VERSION: version, RELEASE_BUMP: SCRIPT },
    });

  test('never fails the tag job', () => {
    expect(step()['continue-on-error']).toBe(true);
    expect(step().run).not.toContain('${{');
  });

  test('warns when a feat shipped as a patch', () => {
    const dir = repoWith(['fix: a', 'feat: b'], 'v1.2.1');
    const r = runStep(dir, 'v1.2.1');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('::warning title=Semver under-bump::');
    expect(r.stdout).toContain('feat: b');
  });

  test('silent when the bump matches', () => {
    const dir = repoWith(['fix: a', 'feat: b'], 'v1.3.0');
    const r = runStep(dir, 'v1.3.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('::warning');
  });
});
