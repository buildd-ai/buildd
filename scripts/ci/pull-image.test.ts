import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Exercises the CI image-pull fallback with a fake `docker` that fails for the
// refs we name, so "the primary registry is rate-limited" is a forced failure
// we can run anywhere, not something we wait for GitHub to reproduce.

const SCRIPT = resolve(import.meta.dir, 'pull-image.sh');

let dir: string;
let log: string;
let fakeDocker: string;

function run(args: string[], failing: string[], attempts = '5') {
  const proc = Bun.spawnSync(['bash', SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      DOCKER: fakeDocker,
      PULL_ATTEMPTS: attempts,
      PULL_BACKOFF_SECONDS: '0',
      FAKE_DOCKER_LOG: log,
      FAKE_DOCKER_FAIL: failing.join(' '),
      GITHUB_OUTPUT: join(dir, 'out'),
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const out = existsSync(join(dir, 'out')) ? readFileSync(join(dir, 'out'), 'utf8') : '';
  return { code: proc.exitCode, calls, out, stdout: proc.stdout.toString() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pull-image-'));
  log = join(dir, 'calls.log');
  fakeDocker = join(dir, 'docker');
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = pull ]; then
  for f in $FAKE_DOCKER_FAIL; do
    if [ "$f" = "$2" ]; then echo "toomanyrequests: Data limit exceeded" >&2; exit 1; fi
  done
fi
exit 0
`,
  );
  chmodSync(fakeDocker, 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const GHCR = 'ghcr.io/buildd-ai/ci-mirror/postgres:17';
const ECR = 'public.ecr.aws/docker/library/postgres:17';
const HUB = 'docker.io/library/postgres:17';

describe('pull-image.sh', () => {
  test('primary works: pulls once, tags it, records the source', () => {
    const r = run(['ci/postgres:17', GHCR, ECR, HUB], []);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([`pull ${GHCR}`, `tag ${GHCR} ci/postgres:17`]);
    expect(r.out).toContain(`source=${GHCR}`);
  });

  test('forced failure of the primary falls back to the next source in the same round', () => {
    const r = run(['ci/postgres:17', GHCR, ECR, HUB], [GHCR]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([`pull ${GHCR}`, `pull ${ECR}`, `tag ${ECR} ci/postgres:17`]);
    expect(r.out).toContain(`source=${ECR}`);
  });

  test('mirror and ECR both limited: Docker Hub serves it', () => {
    const r = run(['ci/postgres:17', GHCR, ECR, HUB], [GHCR, ECR]);
    expect(r.code).toBe(0);
    expect(r.calls.at(-1)).toBe(`tag ${HUB} ci/postgres:17`);
  });

  test('every source down: retries the whole list PULL_ATTEMPTS times, then fails', () => {
    const r = run(['ci/postgres:17', GHCR, ECR, HUB], [GHCR, ECR, HUB], '5');
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => c.startsWith('pull '))).toHaveLength(15);
    expect(r.calls.some((c) => c.startsWith('tag '))).toBe(false);
    expect(r.stdout).toContain('every source failed 5/5 times');
  });

  test('defaults to five rounds (the retry budget the workflow always had)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('ATTEMPTS="${PULL_ATTEMPTS:-5}"');
  });

  test('refuses to run without a candidate', () => {
    const r = run(['ci/postgres:17'], []);
    expect(r.code).toBe(2);
  });
});

describe('workflows use the GHCR mirror', () => {
  const build: any = Bun.YAML.parse(readFileSync('.github/workflows/build.yml', 'utf8'));
  const smoke: any = Bun.YAML.parse(readFileSync('.github/workflows/installer-smoke.yml', 'utf8'));
  const mirror: any = Bun.YAML.parse(readFileSync('.github/workflows/mirror-ci-images.yml', 'utf8'));

  test('DB architecture pulls postgres through the fallback script, GHCR first', () => {
    const job = build.jobs['db-architecture-shards'];
    expect(job.permissions.packages).toBe('read');
    const step = job.steps.find((s: any) => s.name === 'Start Postgres (pgvector)');
    expect(step.run).toContain('scripts/ci/pull-image.sh');
    const order = [GHCR, ECR, HUB].map((ref) => step.run.indexOf(ref));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('installer smoke container jobs use the GHCR image with GITHUB_TOKEN credentials', () => {
    for (const id of ['fresh-install', 'fresh-install-client']) {
      const job = smoke.jobs[id];
      expect(job.container.image).toBe('ghcr.io/buildd-ai/ci-mirror/ubuntu:26.04');
      expect(job.container.credentials.password).toBe('${{ github.token }}');
      expect(job.permissions.packages).toBe('read');
    }
  });

  test('the mirror copies every image the jobs pull, on a schedule and on demand', () => {
    expect(mirror.on.schedule).toBeDefined();
    expect('workflow_dispatch' in mirror.on).toBe(true);
    expect(mirror.jobs.mirror.permissions.packages).toBe('write');
    const targets = mirror.jobs.mirror.strategy.matrix.include.map((i: any) => `ghcr.io/buildd-ai/ci-mirror/${i.name}:${i.tag}`);
    expect(targets).toContain(GHCR);
    expect(targets).toContain('ghcr.io/buildd-ai/ci-mirror/ubuntu:26.04');
  });

  test('only dev can push-trigger the mirror, so no other branch can overwrite the shared tags', () => {
    // It runs with packages: write. A push from any other branch would run that branch's own copy.
    expect(mirror.on.push?.branches).toEqual(['dev']);
    expect('pull_request' in mirror.on).toBe(false);
    expect('pull_request_target' in mirror.on).toBe(false);
  });
});
