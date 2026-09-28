import { describe, test, expect, beforeAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * `publish-ai-kit.yml` used to run only on a hand-pushed `ai-kit-v*` tag, so a
 * merged version bump sat unpublished until someone remembered to tag it (0.4.0
 * and 0.5.0 never shipped at all). Now a push to dev that changes the kit's
 * `version` publishes and then tags.
 *
 * The two decisions that matter are run as logic, not read as YAML prose: the
 * `plan` step and the publish job's version check contain no `${{ }}`
 * interpolation, so they are extracted and executed against scratch repos with
 * a fake `npm` on PATH.
 */

const WORKFLOW = '.github/workflows/publish-ai-kit.yml';

function workflow(): any {
  return Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8'));
}

function step(job: string, name: string): any {
  const found = workflow().jobs[job]?.steps.find((s: any) => s.name === name);
  expect(found, `${WORKFLOW} job ${job} has no step named "${name}"`).toBeDefined();
  return found;
}

const git = (repo: string, ...args: string[]) =>
  spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

/** An `npm` whose `view <pkg>@<v> version` knows only the versions in FAKE_NPM_PUBLISHED. */
function fakeNpmDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-npm-'));
  const npm = join(dir, 'npm');
  writeFileSync(
    npm,
    `#!/usr/bin/env bash
if [ "$1" = view ]; then
  v="\${2##*@}"
  for p in $FAKE_NPM_PUBLISHED; do
    if [ "$p" = "$v" ]; then echo "$v"; exit 0; fi
  done
  echo "npm error code E404" >&2; exit 1
fi
echo "unexpected npm $*" >&2; exit 2
`,
  );
  chmodSync(npm, 0o755);
  return dir;
}
const FAKE_NPM = fakeNpmDir();

function writeKit(repo: string, version: string, changelogVersion = version) {
  mkdirSync(join(repo, 'packages/ai-kit'), { recursive: true });
  writeFileSync(
    join(repo, 'packages/ai-kit/package.json'),
    JSON.stringify({ name: '@builddai/ai-kit', version }, null, 2),
  );
  writeFileSync(
    join(repo, 'packages/ai-kit/CHANGELOG.md'),
    `# changelog\n\n## ${changelogVersion} — 2026-01-01\n\n- things\n`,
  );
}

function commit(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD').stdout.trim();
}

/** A clone of a bare `origin`, with the kit at `version` in one pushed commit. */
function scratchRepo(version: string): { repo: string; origin: string } {
  const origin = mkdtempSync(join(tmpdir(), 'ai-kit-origin-'));
  git(origin, 'init', '-q', '--bare', '-b', 'dev');
  const repo = mkdtempSync(join(tmpdir(), 'ai-kit-'));
  git(repo, 'init', '-q', '-b', 'dev');
  git(repo, 'config', 'user.email', 't@t.test');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'remote', 'add', 'origin', origin);
  writeKit(repo, version);
  commit(repo, 'first');
  git(repo, 'push', '-q', 'origin', 'dev');
  return { repo, origin };
}

function run(
  script: string,
  repo: string,
  env: Record<string, string>,
): { code: number; outputs: Record<string, string>; log: string } {
  expect(script).not.toContain('${{'); // else this harness is lying about what CI runs
  const outFile = join(mkdtempSync(join(tmpdir(), 'gh-output-')), 'out');
  writeFileSync(outFile, '');
  const res = spawnSync('bash', ['-c', script], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${FAKE_NPM}:${process.env.PATH}`,
      GITHUB_OUTPUT: outFile,
      FAKE_NPM_PUBLISHED: '',
      ...env,
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(outFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { code: res.status ?? -1, outputs, log: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

const plan = (repo: string, env: Record<string, string> = {}) =>
  run(step('plan', 'Decide whether this push releases the kit').run, repo, env);

const versionCheck = (repo: string, env: Record<string, string> = {}) =>
  run(step('publish', 'Check the tag matches the package version').run, repo, env);

describe('publish-ai-kit workflow: shape', () => {
  beforeAll(() => {
    expect(workflow().jobs.plan).toBeDefined();
    expect(workflow().jobs.publish).toBeDefined();
    expect(workflow().jobs.tag).toBeDefined();
  });

  test('a push to dev touching the kit package.json triggers it, and tag pushes still do', () => {
    const push = workflow().on.push;
    expect(push.branches).toEqual(['dev']);
    expect(push.paths).toEqual(['packages/ai-kit/package.json']);
    expect(push.tags).toEqual(['ai-kit-v*']);
  });

  test('publishing happens in this run, not via a tag push GITHUB_TOKEN cannot trigger', () => {
    // A tag pushed with GITHUB_TOKEN starts no workflow. The dev-push path must
    // reach `npm publish` without one: publish needs plan and runs on its say-so.
    const publish = workflow().jobs.publish;
    expect(publish.needs).toBe('plan');
    const cond = String(publish.if);
    expect(cond).toContain("needs.plan.outputs.publish == 'true'");
    // …and on tag push / dispatch, where plan is skipped.
    expect(cond).toContain("needs.plan.result == 'skipped'");
    expect(cond).toContain('!cancelled()');
    expect(publish.permissions['id-token']).toBe('write');
  });

  test('the tag is created only after a successful publish', () => {
    const tag = workflow().jobs.tag;
    expect(tag.needs).toEqual(['plan', 'publish']);
    expect(String(tag.if)).toContain("needs.plan.outputs.publish == 'true'");
    expect(String(tag.if)).toContain("needs.publish.result == 'success'");
    expect(tag.permissions.contents).toBe('write');
  });

  test('only the tag job can write to the repo', () => {
    const wf = workflow();
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.jobs.plan.permissions).toBeUndefined();
    expect(wf.jobs.publish.permissions.contents).toBe('read');
  });

  test('the real publish is gated on the version check, and still skips a published version', () => {
    expect(String(step('publish', 'Publish to npm with provenance').if)).toContain('steps.version.outputs.real');
    expect(String(step('publish', 'Publish (dry run)').if)).toContain('steps.version.outputs.real');
    expect(step('publish', 'Publish to npm with provenance').run).toContain('already on npm');
  });
});

describe('publish-ai-kit workflow: plan (push to dev)', () => {
  test('a version bump ⇒ publish, with the matching tag', () => {
    const { repo } = scratchRepo('0.4.0');
    const before = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    writeKit(repo, '0.5.0');
    commit(repo, 'bump');
    const { code, outputs } = plan(repo, { BEFORE: before, FAKE_NPM_PUBLISHED: '0.4.0' });
    expect(code).toBe(0);
    expect(outputs.publish).toBe('true');
    expect(outputs.version).toBe('0.5.0');
    expect(outputs.tag).toBe('ai-kit-v0.5.0');
  });

  test('no version change (another edit to package.json) ⇒ no-op', () => {
    const { repo } = scratchRepo('0.4.0');
    const before = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    writeFileSync(
      join(repo, 'packages/ai-kit/package.json'),
      JSON.stringify({ name: '@builddai/ai-kit', version: '0.4.0', description: 'edited' }),
    );
    commit(repo, 'edit description');
    const { code, outputs, log } = plan(repo, { BEFORE: before });
    expect(code).toBe(0);
    expect(outputs.publish).toBe('false');
    expect(log).toContain('unchanged');
  });

  test('re-running the same version once it is on npm ⇒ no-op', () => {
    const { repo } = scratchRepo('0.4.0');
    const before = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    writeKit(repo, '0.5.0');
    commit(repo, 'bump');
    const { code, outputs, log } = plan(repo, { BEFORE: before, FAKE_NPM_PUBLISHED: '0.4.0 0.5.0' });
    expect(code).toBe(0);
    expect(outputs.publish).toBe('false');
    expect(log).toContain('already on npm');
  });

  test('re-running the same version once it is tagged ⇒ no-op', () => {
    const { repo } = scratchRepo('0.4.0');
    const before = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    writeKit(repo, '0.5.0');
    commit(repo, 'bump');
    git(repo, 'tag', 'ai-kit-v0.5.0');
    git(repo, 'push', '-q', 'origin', 'ai-kit-v0.5.0');
    const { code, outputs, log } = plan(repo, { BEFORE: before });
    expect(code).toBe(0);
    expect(outputs.publish).toBe('false');
    expect(log).toContain('already exists');
  });

  test('a bump earlier in a multi-commit push still counts (compares to the pre-push tip)', () => {
    const { repo } = scratchRepo('0.4.0');
    const before = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    writeKit(repo, '0.5.0');
    commit(repo, 'bump');
    writeFileSync(join(repo, 'unrelated.txt'), 'x');
    commit(repo, 'later');
    expect(plan(repo, { BEFORE: before }).outputs.publish).toBe('true');
  });

  test('without a usable `before` it falls back to the parent commit', () => {
    const { repo } = scratchRepo('0.4.0');
    writeKit(repo, '0.5.0');
    commit(repo, 'bump');
    expect(plan(repo, { BEFORE: '0000000000000000000000000000000000000000' }).outputs.publish).toBe('true');
    expect(plan(repo, { BEFORE: '' }).outputs.publish).toBe('true');

    writeFileSync(join(repo, 'unrelated.txt'), 'x');
    commit(repo, 'later');
    expect(plan(repo, { BEFORE: '' }).outputs.publish).toBe('false');
  });

  test('a non-exact version fails loudly', () => {
    const { repo } = scratchRepo('0.4.0');
    const before = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    writeKit(repo, '0.5.0-beta.1');
    commit(repo, 'bump');
    const { code, log } = plan(repo, { BEFORE: before });
    expect(code).not.toBe(0);
    expect(log).toContain('::error');
  });
});

describe('publish-ai-kit workflow: version check (publish job)', () => {
  test('the auto path passes with the planned tag and marks a real publish', () => {
    const { repo } = scratchRepo('0.5.0');
    const { code, outputs } = versionCheck(repo, {
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'dev',
      PLANNED_TAG: 'ai-kit-v0.5.0',
    });
    expect(code).toBe(0);
    expect(outputs.real).toBe('true');
    expect(outputs.version).toBe('0.5.0');
  });

  test('a hand-pushed tag must equal ai-kit-v<version>', () => {
    const { repo } = scratchRepo('0.5.0');
    const ok = versionCheck(repo, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'ai-kit-v0.5.0' });
    expect(ok.code).toBe(0);
    expect(ok.outputs.real).toBe('true');

    const bad = versionCheck(repo, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'ai-kit-v0.4.0' });
    expect(bad.code).not.toBe(0);
    expect(bad.log).toContain('does not match');
    expect(bad.outputs.real).toBeUndefined();
  });

  test('a release without a CHANGELOG heading fails before publishing', () => {
    const { repo } = scratchRepo('0.5.0');
    writeKit(repo, '0.5.0', '0.4.0');
    const { code, outputs, log } = versionCheck(repo, {
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'dev',
      PLANNED_TAG: 'ai-kit-v0.5.0',
    });
    expect(code).not.toBe(0);
    expect(log).toContain("no '## 0.5.0' heading");
    expect(outputs.real).toBeUndefined();
  });

  test('a heading that merely starts with the version does not count', () => {
    const { repo } = scratchRepo('0.5.0');
    writeKit(repo, '0.5.0', '0.5.01');
    const { code } = versionCheck(repo, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'ai-kit-v0.5.0' });
    expect(code).not.toBe(0);
  });

  test('dispatch on a branch is a dry run, and a ticked publish there is refused', () => {
    const { repo } = scratchRepo('0.5.0');
    const dry = versionCheck(repo, { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'dev', DISPATCH_PUBLISH: 'false' });
    expect(dry.code).toBe(0);
    expect(dry.outputs.real).toBe('false');

    const refused = versionCheck(repo, { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'dev', DISPATCH_PUBLISH: 'true' });
    expect(refused.code).not.toBe(0);
    expect(refused.log).toContain('must run on an ai-kit-v* tag');
  });

  test('the real kit on this checkout passes its own version check', () => {
    // CHANGELOG heading for the current version, so the next merge can publish.
    const version = JSON.parse(readFileSync('packages/ai-kit/package.json', 'utf8')).version;
    const res = versionCheck(process.cwd(), {
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: `ai-kit-v${version}`,
    });
    expect(res.code, res.log).toBe(0);
  });
});
