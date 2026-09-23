import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * `release:hotfix` used to compute the next patch version and use it only in
 * the PR title. It never bumped a package.json, so when the hotfix merged,
 * Tag Release read the version main already had, found it tagged at an older
 * commit, and failed — every hotfix shipped to production untagged. The
 * failure's own advice ("run release:hotfix") looped straight back into it.
 *
 * These tests run the real script against a scratch repo with a bare origin,
 * with a `gh` stub on PATH that records its arguments.
 */

const SCRIPT = resolve('scripts/release.sh');
const WORKFLOW = resolve('.github/workflows/release-tag.yml');
const PACKAGE_FILES = [
  'apps/runner/package.json',
  'apps/web/package.json',
  'packages/core/package.json',
  'packages/shared/package.json',
];

const run = (cwd: string, cmd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const git = (cwd: string, ...args: string[]) => {
  const r = run(cwd, 'git', args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

interface Fixture {
  root: string;
  work: string;
  origin: string;
  ghLog: string;
  ghOpenTitles: string;
  bin: string;
}

/** main at `version`, tagged `v<version>`, plus a hotfix branch with one fix commit. */
function fixture(version = '1.2.3'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'release-hotfix-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  run(root, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  run(root, 'git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 't@t.test');
  git(work, 'config', 'user.name', 'T');
  git(work, 'config', 'commit.gpgsign', 'false');
  git(work, 'config', 'tag.gpgsign', 'false');
  for (const p of PACKAGE_FILES) {
    mkdirSync(join(work, p, '..'), { recursive: true });
    writeFileSync(join(work, p), JSON.stringify({ name: p, version }, null, 2) + '\n');
  }
  writeFileSync(
    join(work, 'CHANGELOG.md'),
    `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- a fix\n\n## [${version}] - 2000-01-01\n\n- old\n\n[Unreleased]: https://github.com/o/r/compare/v${version}...HEAD\n`,
  );
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'initial');
  git(work, 'tag', `v${version}`);
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main', '--tags');
  git(work, 'checkout', '-qb', 'hotfix/thing');
  writeFileSync(join(work, 'fix.txt'), 'fixed');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'fix: the thing');

  const ghLog = join(root, 'gh.log');
  const ghOpenTitles = join(root, 'gh-open-titles');
  writeFileSync(ghLog, '');
  writeFileSync(ghOpenTitles, '');
  const stub = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${ghLog}"
case "$1 $2" in
  "repo view") echo "o/r" ;;
  "pr list") cat "${ghOpenTitles}" ;;
  "pr create")
    if [ -n "\${GH_PR_CREATE_FAIL:-}" ]; then echo "gh: network down" >&2; exit 1; fi
    echo "https://github.com/o/r/pull/1" ;;
esac
`;
  writeFileSync(join(bin, 'gh'), stub);
  chmodSync(join(bin, 'gh'), 0o755);
  return { root, work, origin, ghLog, ghOpenTitles, bin };
}

function hotfix(f: Fixture, env: Record<string, string> = {}) {
  return run(f.work, 'bash', [SCRIPT, '--hotfix'], { PATH: `${f.bin}:${process.env.PATH}`, ...env });
}

const version = (dir: string, p: string) => JSON.parse(readFileSync(join(dir, p), 'utf8')).version;
const originHasBranch = (f: Fixture) =>
  run(f.origin, 'git', ['rev-parse', '-q', '--verify', 'refs/heads/hotfix/thing']).status === 0;

function resolveStep(): string {
  const wf = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as any;
  const s = wf.jobs.tag.steps.find((x: any) => x.name === 'Resolve the shipped version');
  expect(s).toBeDefined();
  return s.run as string;
}

describe('release.sh --hotfix', () => {
  test('bumps every package.json, commits the bump, and titles the PR with it', () => {
    const f = fixture();
    const r = hotfix(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);

    for (const p of PACKAGE_FILES) expect(version(f.work, p)).toBe('1.2.4');
    expect(git(f.work, 'log', '-1', '--format=%s')).toBe('chore: bump version to v1.2.4');
    expect(readFileSync(join(f.work, 'CHANGELOG.md'), 'utf8')).toContain('## [1.2.4]');
    // The bump is what got pushed, not just the fix.
    expect(git(f.origin, 'rev-parse', 'refs/heads/hotfix/thing')).toBe(git(f.work, 'rev-parse', 'HEAD'));

    const ghCalls = readFileSync(f.ghLog, 'utf8');
    expect(ghCalls).toContain('pr create');
    expect(ghCalls).toContain('--title Hotfix v1.2.4');
  });

  test('bumps past a version main already carries but has not tagged', () => {
    // main's package.json is ahead of the latest tag (an untagged prior ship):
    // reusing latest-tag + 1 would collide with what main already claims.
    const f = fixture();
    git(f.work, 'checkout', '-q', 'main');
    for (const p of PACKAGE_FILES) {
      writeFileSync(join(f.work, p), JSON.stringify({ name: p, version: '1.2.4' }) + '\n');
    }
    git(f.work, 'commit', '-qam', 'chore: bump version to v1.2.4');
    git(f.work, 'push', '-q', 'origin', 'main');
    git(f.work, 'checkout', '-q', 'hotfix/thing');

    const r = hotfix(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(version(f.work, 'apps/web/package.json')).toBe('1.2.5');
  });

  test('sees tags that only origin has, so it never reuses a taken version', () => {
    // A tag pushed from another checkout (a concurrent release) is invisible
    // until fetched; computing from local tags alone would reuse it.
    const f = fixture();
    const other = join(f.root, 'other');
    run(f.root, 'git', ['clone', '-q', f.origin, other]);
    git(other, 'tag', 'v1.2.4', 'HEAD');
    git(other, 'push', '-q', 'origin', 'v1.2.4');

    const r = hotfix(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(f.ghLog, 'utf8')).toContain('--title Hotfix v1.2.5');
    expect(version(f.work, 'apps/web/package.json')).toBe('1.2.5');
  });

  test('refuses when an open PR already claims the version, and pushes nothing', () => {
    const f = fixture();
    writeFileSync(f.ghOpenTitles, 'Release v1.2.4\n');
    const r = hotfix(f);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('v1.2.4');
    expect(originHasBranch(f)).toBe(false);
    expect(readFileSync(f.ghLog, 'utf8')).not.toContain('pr create');
    expect(version(f.work, 'apps/web/package.json')).toBe('1.2.3');
  });

  test('refuses an open Hotfix PR for the same version too', () => {
    const f = fixture();
    writeFileSync(f.ghOpenTitles, 'Hotfix v1.2.4\n');
    const r = hotfix(f);
    expect(r.status).not.toBe(0);
    expect(originHasBranch(f)).toBe(false);
  });

  test('re-running after a failed PR create reuses the bump commit instead of dying', () => {
    // The first run commits the bump, then `gh pr create` fails. origin/main
    // has not moved, so the second run computes the same version; re-bumping
    // is a no-op and used to abort with "changed no files".
    const f = fixture();
    const first = hotfix(f, { GH_PR_CREATE_FAIL: '1' });
    expect(first.status).not.toBe(0);
    expect(git(f.work, 'log', '-1', '--format=%s')).toBe('chore: bump version to v1.2.4');
    const headAfterFirst = git(f.work, 'rev-parse', 'HEAD');

    const second = hotfix(f);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    // No second bump commit stacked on top.
    expect(git(f.work, 'rev-parse', 'HEAD')).toBe(headAfterFirst);
    expect(git(f.work, 'rev-list', '--count', 'origin/main..HEAD')).toBe('2');
    for (const p of PACKAGE_FILES) expect(version(f.work, p)).toBe('1.2.4');
    expect(readFileSync(f.ghLog, 'utf8')).toContain('--title Hotfix v1.2.4');
    expect(git(f.origin, 'rev-parse', 'refs/heads/hotfix/thing')).toBe(headAfterFirst);
  });

  test('the collision check reads past gh pr list default page size', () => {
    const f = fixture();
    expect(hotfix(f).status).toBe(0);
    const list = readFileSync(f.ghLog, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('pr list'));
    expect(list).toBeDefined();
    expect(list).toMatch(/--limit \d{3,}/);
  });

  // The `refs/tags/${NEW_VERSION}` refusal in release.sh is defense-in-depth:
  // NEW_VERSION is derived from max(latest tag, main's version) + 1, so it is
  // above every tag the fetch saw and the guard is unreachable in practice.
  // 'sees tags that only origin has' covers the realistic path to a taken tag.

  test('once merged, Tag Release resolves a fresh tag instead of failing', () => {
    const f = fixture();
    expect(hotfix(f).status).toBe(0);

    // Simulate the merge: main now points at the hotfix branch head.
    git(f.work, 'push', '-q', 'origin', 'hotfix/thing:main');
    const merged = join(f.root, 'merged');
    run(f.root, 'git', ['clone', '-q', '-b', 'main', f.origin, merged]);
    git(merged, 'fetch', '-q', '--tags');

    const out = join(f.root, 'gh-output');
    writeFileSync(out, '');
    const r = run(merged, 'bash', ['-c', resolveStep()], { GITHUB_OUTPUT: out });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const outputs = readFileSync(out, 'utf8');
    expect(outputs).toContain('needs_tag=true');
    expect(outputs).toContain('version=v1.2.4');
  });

  test('the Tag Release failure advice no longer loops back into release:hotfix alone', () => {
    const yml = readFileSync(WORKFLOW, 'utf8');
    // The old advice was "Bump the version (bun run release:hotfix)", which
    // could not bump anything, or `--tag`, a no-op on an already-tagged version.
    expect(yml).not.toContain('Bump the version (bun run release:hotfix)');
    const advice = resolveStep();
    expect(advice).toContain('gh release create');
    expect(advice).not.toContain('scripts/release.sh --tag');
  });

  test('an untagged ship files a deduped friction task instead of a silent red run', () => {
    const wf = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as any;
    const notify = wf.jobs.tag.steps.find((s: any) => /friction/i.test(s.name ?? ''));
    expect(notify).toBeDefined();
    expect(String(notify.if)).toContain('failure()');
    // Only the "already tagged at an older commit" branch, not every failure of
    // the step: an unreadable package.json is a different diagnosis.
    expect(String(notify.if)).toContain("steps.version.outputs.untagged == 'true'");
    expect(resolveStep()).toContain('echo "untagged=true" >> "$GITHUB_OUTPUT"');
    expect(String(notify.run)).toContain('frictionSignature: "release-untagged-main"');
    expect(String(notify.run)).toContain('/api/tasks');
  });
});
