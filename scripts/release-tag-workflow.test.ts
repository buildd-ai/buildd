import { describe, test, expect, beforeAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * `release-tag.yml` is the only thing that tags what production shipped, and it
 * has put untagged code into production twice over, two different ways:
 *
 *   - It was gated on the PR title (`Release v`/`Hotfix v`). 18 merged PRs did
 *     not match — #858 "Hotfix OAuth loopback redirect validation" starts with
 *     `Hotfix ` but not `Hotfix v` — so the job never ran at all.
 *   - It called `git tag` unconditionally, so a version that was already tagged
 *     killed the step with exit 128 (run 33274797597, Hotfix v0.186.1 merging
 *     1h47m after Release v0.186.1 had taken the tag). The hotfix deployed
 *     covered by no tag, and the only trace was a red run nobody watched.
 *
 * The decision the workflow makes is therefore worth testing as logic rather
 * than as YAML prose: the `Resolve the shipped version` step's script contains
 * no `${{ }}` interpolation, so it is extracted and run against real scratch
 * repositories below.
 */

const WORKFLOW = '.github/workflows/release-tag.yml';

function workflow(): any {
  return Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8'));
}

function step(name: string): any {
  const found = workflow().jobs.tag.steps.find((s: any) => s.name === name);
  expect(found, `${WORKFLOW} has no step named "${name}"`).toBeDefined();
  return found;
}

/** Run the resolve step's real script in a scratch repo; return outputs + exit code. */
function resolveIn(repo: string): { code: number; outputs: Record<string, string>; stderr: string } {
  const script = step('Resolve the shipped version').run as string;
  expect(script).not.toContain('${{'); // else this harness is lying about what CI runs

  const outFile = join(repo, '.gh-output');
  writeFileSync(outFile, '');
  const res = spawnSync('bash', ['-c', script], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: outFile },
  });
  const outputs = Object.fromEntries(
    readFileSync(outFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { code: res.status ?? -1, outputs, stderr: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

const git = (repo: string, ...args: string[]) =>
  spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

/** A scratch repo whose apps/web/package.json declares `version`, with one commit. */
function scratchRepo(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-tag-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.test');
  git(dir, 'config', 'user.name', 'T');
  mkdirSync(join(dir, 'apps/web'), { recursive: true });
  writeFileSync(join(dir, 'apps/web/package.json'), JSON.stringify({ version }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'first');
  return dir;
}

describe('release-tag workflow', () => {
  beforeAll(() => {
    // A renamed step or file would make every assertion below vacuous.
    expect(workflow().jobs.tag).toBeDefined();
  });

  test('tags every merged PR to main, not only title-matching ones', () => {
    const condition = String(workflow().jobs.tag.if);
    expect(condition).toContain('merged');
    // The title gate is what let 18 production deploys ship untagged.
    expect(condition).not.toContain('title');
    expect(readFileSync(WORKFLOW, 'utf8')).not.toContain('pull_request.title');
  });

  test('an untagged version is tagged at the merged commit', () => {
    const repo = scratchRepo('1.2.3');
    const { code, outputs } = resolveIn(repo);
    expect(code).toBe(0);
    expect(outputs.needs_tag).toBe('true');
    expect(outputs.version).toBe('v1.2.3');
    expect(outputs.head_sha).toBe(git(repo, 'rev-parse', 'HEAD').stdout.trim());
  });

  test('a version already tagged at this very commit is a clean no-op', () => {
    // Webhook redelivery must not fail, and must not re-tag.
    const repo = scratchRepo('1.2.3');
    git(repo, 'tag', 'v1.2.3');
    const { code, outputs } = resolveIn(repo);
    expect(code).toBe(0);
    expect(outputs.needs_tag).toBe('false');
  });

  test('a version tagged at a DIFFERENT commit fails loudly instead of shipping untagged', () => {
    // The v0.186.1 collision: the tag exists from an earlier release, and this
    // merge has deployed a commit that no tag covers.
    const repo = scratchRepo('1.2.3');
    git(repo, 'tag', 'v1.2.3');
    writeFileSync(join(repo, 'later.txt'), 'shipped');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'later work');

    const { code, outputs, stderr } = resolveIn(repo);
    expect(code).not.toBe(0);
    expect(outputs.needs_tag).toBeUndefined();
    expect(stderr).toContain('::error');
    expect(stderr).toContain('covered by no tag');
  });

  test('a missing version fails rather than tagging something arbitrary', () => {
    const repo = scratchRepo('1.2.3');
    writeFileSync(join(repo, 'apps/web/package.json'), JSON.stringify({ name: 'x' }));
    const { code, stderr } = resolveIn(repo);
    expect(code).not.toBe(0);
    expect(stderr).toContain('::error');
  });

  test('the after-push check rejects an unguarded pipeline', () => {
    // Guard against the guard: a version of this that skipped every line would
    // pass vacuously, which is the failure mode this file exists to prevent.
    const unguarded = 'git push origin "$V"\nNOTES=$(git log | grep -v x)\n';
    const offending = unguarded
      .slice(unguarded.indexOf('git push origin'))
      .split('\n')
      .filter(l => !/^\s*#/.test(l) && /\bgrep\b/.test(l) && !/\|\|\s*true/.test(l));
    expect(offending).toHaveLength(1);
  });

  test('tagging is conditioned on the resolve outcome, never unconditional', () => {
    expect(String(step('Tag and release').if)).toContain('needs_tag');
  });

  test('no pipeline can fail after the tag has been pushed', () => {
    // `grep -v` exits 1 when it selects nothing. Under `set -e`, after
    // `git push origin "$VERSION"`, that leaves a tag with no GitHub release —
    // reachable whenever a release's only commit is the version bump.
    const script = String(step('Tag and release').run);
    const afterPush = script.slice(script.indexOf('git push origin'));
    for (const line of afterPush.split('\n')) {
      // Comment lines first: the prose explaining this hazard names `grep -v`,
      // and matching it is how a check ends up asserting against itself.
      if (/^\s*#/.test(line)) continue;
      if (!/\bgrep\b/.test(line)) continue;
      expect(line, `unguarded grep after the tag push: ${line.trim()}`).toMatch(/\|\|\s*true/);
    }
  });
});
