import { describe, test, expect, beforeAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * `publish-runner-image.yml` writes the public runner image tags. Its two
 * decision steps carry no `${{ }}` interpolation, so they are extracted and
 * run for real here: what gets published, from which ref, and when `:latest`
 * moves. Each refusal is asserted to actually fail, because a gate that cannot
 * fail measures nothing.
 */

const WORKFLOW = '.github/workflows/publish-runner-image.yml';
const RELEASE_TAG = '.github/workflows/release-tag.yml';

const parse = (file: string): any => Bun.YAML.parse(readFileSync(file, 'utf8'));

function step(job: string, name: string): any {
  const found = parse(WORKFLOW).jobs[job]?.steps?.find((s: any) => s.name === name);
  expect(found, `${WORKFLOW} job ${job} has no step named "${name}"`).toBeDefined();
  return found;
}

/** `on:` parses as the boolean `true` in YAML 1.1. */
const triggers = (parsed: any) => parsed.on ?? parsed[true as unknown as string];

function runScript(script: string, cwd: string, env: Record<string, string>) {
  expect(script).not.toContain('${{'); // else this harness is lying about what CI runs
  const outFile = join(cwd, '.gh-output');
  writeFileSync(outFile, '');
  const res = spawnSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env, GITHUB_OUTPUT: outFile },
  });
  const outputs = Object.fromEntries(
    readFileSync(outFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { code: res.status ?? -1, outputs, log: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function plan(env: Record<string, string>) {
  return runScript(step('plan', 'Resolve what to publish').run, mkdtempSync(join(tmpdir(), 'runner-image-plan-')), env);
}

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/**
 * A clone whose origin carries `tags`, checked out at `checkout`, where
 * apps/runner/package.json says `runnerVersion`.
 */
function checkoutAt(runnerVersion: string, tags: string[], checkout: string): string {
  const origin = mkdtempSync(join(tmpdir(), 'runner-image-origin-'));
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'user.email', 't@t.test');
  git(origin, 'config', 'user.name', 'T');
  mkdirSync(join(origin, 'apps/runner'), { recursive: true });
  writeFileSync(join(origin, 'apps/runner/package.json'), JSON.stringify({ version: runnerVersion }));
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'release');
  for (const t of tags) git(origin, 'tag', t);
  const clone = mkdtempSync(join(tmpdir(), 'runner-image-clone-'));
  git(clone, 'clone', '-q', origin, '.');
  git(clone, 'checkout', '-q', checkout);
  return clone;
}

function checkTag(repo: string, tag: string) {
  return runScript(step('publish', 'Check the tag against the checkout').run, repo, { TAG: tag });
}

describe('publish-runner-image workflow', () => {
  beforeAll(() => {
    // A renamed job would make every assertion below vacuous.
    const jobs = parse(WORKFLOW).jobs;
    expect(Object.keys(jobs).sort()).toEqual(['dry-run', 'plan', 'publish']);
  });

  describe('plan', () => {
    test('a pushed v* tag is published', () => {
      const { code, outputs } = plan({ EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3', GITHUB_REF: 'refs/tags/v1.2.3' });
      expect(code).toBe(0);
      expect(outputs).toEqual({ publish: 'true', tag: 'v1.2.3' });
    });

    test('a dispatch on main with a tag is published (the Tag Release path)', () => {
      const { code, outputs } = plan({ EVENT_NAME: 'workflow_dispatch', INPUT_TAG: 'v1.2.3', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', GITHUB_REF: 'refs/heads/main' });
      expect(code).toBe(0);
      expect(outputs).toEqual({ publish: 'true', tag: 'v1.2.3' });
    });

    test('a dispatch with a tag from any other branch fails and publishes nothing', () => {
      const { code, outputs, log } = plan({ EVENT_NAME: 'workflow_dispatch', INPUT_TAG: 'v1.2.3', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'feature', GITHUB_REF: 'refs/heads/feature' });
      expect(code).not.toBe(0);
      expect(outputs.publish).toBeUndefined();
      expect(log).toContain('::error::');
    });

    test('a tag that is not vX.Y.Z fails', () => {
      for (const bad of ['1.2.3', 'v1.2', 'v1.2.3-rc.1', 'vlatest']) {
        const { code, outputs } = plan({ EVENT_NAME: 'workflow_dispatch', INPUT_TAG: bad, GITHUB_REF: 'refs/heads/main' });
        expect(code, bad).not.toBe(0);
        expect(outputs.publish, bad).toBeUndefined();
      }
    });

    test('a dispatch without a tag, and a pull request, are dry runs', () => {
      for (const env of [
        { EVENT_NAME: 'workflow_dispatch', INPUT_TAG: '', GITHUB_REF: 'refs/heads/some-branch' },
        { EVENT_NAME: 'pull_request', GITHUB_REF_TYPE: 'branch', GITHUB_REF: 'refs/pull/1/merge' },
      ]) {
        const { code, outputs } = plan(env);
        expect(code).toBe(0);
        expect(outputs).toEqual({ publish: 'false' });
      }
    });
  });

  describe('check the tag against the checkout', () => {
    test('the highest tag, matching the runner version, publishes and moves :latest', () => {
      const repo = checkoutAt('1.10.0', ['v1.9.0', 'v1.10.0'], 'v1.10.0');
      const { code, outputs } = checkTag(repo, 'v1.10.0');
      expect(code).toBe(0);
      expect(outputs.latest).toBe('true'); // version order, not string order
      expect(outputs.revision).toBe(git(repo, 'rev-parse', 'HEAD').stdout.trim());
    });

    test('a backfill of an older tag leaves :latest alone', () => {
      const repo = checkoutAt('1.9.0', ['v1.9.0', 'v1.10.0'], 'v1.9.0');
      const { code, outputs } = checkTag(repo, 'v1.9.0');
      expect(code).toBe(0);
      expect(outputs.latest).toBe('false');
    });

    test('a runner version that does not match the tag fails before anything is built', () => {
      const repo = checkoutAt('1.9.0', ['v1.10.0'], 'v1.10.0');
      const { code, outputs, log } = checkTag(repo, 'v1.10.0');
      expect(code).not.toBe(0);
      expect(outputs.latest).toBeUndefined();
      expect(log).toContain('::error::');
    });
  });

  describe('wiring', () => {
    test('only the publish job can write packages, and only after the checks and smoke', () => {
      const wf = parse(WORKFLOW);
      expect(wf.permissions).toEqual({ contents: 'read' });
      expect(wf.jobs.publish.permissions).toEqual({ contents: 'read', packages: 'write' });
      expect(wf.jobs['dry-run'].permissions).toBeUndefined();
      expect(wf.jobs.plan.permissions).toBeUndefined();
      expect(String(wf.jobs.publish.if)).toContain("publish == 'true'");

      const names = wf.jobs.publish.steps.map((s: any) => s.name);
      const before = (a: string, b: string) => expect(names.indexOf(a), `${a} before ${b}`).toBeLessThan(names.indexOf(b));
      expect(names.indexOf('Push')).toBeGreaterThan(-1);
      before('Check the tag against the checkout', 'Push');
      before('Smoke', 'Push');
      before('Push', 'Record the digest');
    });

    test('the publish job builds the tag, not the dispatching ref', () => {
      const checkout = parse(WORKFLOW).jobs.publish.steps.find((s: any) => String(s.uses).startsWith('actions/checkout'));
      expect(checkout.with.ref).toBe('refs/tags/${{ needs.plan.outputs.tag }}');
    });

    test('both build steps label the image with source, revision and version', () => {
      for (const job of ['dry-run', 'publish']) {
        const run = String(step(job, 'Build').run);
        for (const label of ['source', 'revision', 'version']) {
          expect(run, `${job}: ${label}`).toContain(`org.opencontainers.image.${label}=`);
        }
        expect(run).toContain('--platform linux/amd64');
        expect(run).toContain('apps/runner/Dockerfile.once');
      }
    });

    test('triggers: hand-pushed v* tags, dispatch with a tag input, and PRs touching the image', () => {
      const on = triggers(parse(WORKFLOW));
      expect(on.push.tags).toEqual(['v*']);
      expect(on.push.branches).toBeUndefined();
      expect(on.workflow_dispatch.inputs.tag).toBeDefined();
      expect(on.pull_request.paths).toContain('apps/runner/Dockerfile.once');
    });

    test('Tag Release dispatches this workflow on main for the tag it just pushed', () => {
      // Its tag push uses GITHUB_TOKEN, which starts no workflow, so `push:
      // tags` alone would never publish a release.
      const job = parse(RELEASE_TAG).jobs.tag;
      expect(job.permissions.actions).toBe('write');
      const dispatch = job.steps.find((s: any) => s.name === 'Publish the runner image for this tag');
      expect(dispatch).toBeDefined();
      expect(String(dispatch.if)).toContain('needs_tag');
      expect(dispatch.run).toContain('gh workflow run publish-runner-image.yml');
      expect(dispatch.run).toContain('--ref main');
      expect(dispatch.run).toContain('-f tag="$VERSION"');
      expect(dispatch.env.VERSION).toBe('${{ steps.version.outputs.version }}');
      // Last, so a failed dispatch skips none of the release checks.
      expect(job.steps.at(-1)).toBe(dispatch);
    });
  });
});
