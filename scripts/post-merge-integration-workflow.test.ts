import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

// Read, not imported: dispatch.ts pulls in the GitHub client and its env.
const POST_MERGE_INTEGRATION_CHECK_PREFIX = /POST_MERGE_INTEGRATION_CHECK_PREFIX = '([^']+)'/.exec(
  readFileSync('apps/web/src/lib/release/dispatch.ts', 'utf8'),
)?.[1] as string;

/**
 * API integration tests used to run only on PRs into `main` whose head was not
 * `dev` — i.e. hotfixes. Nothing ran them on the dev→main path, so a claim-SQL
 * regression reached production through that gap. They now also run on every
 * push to `dev`, post-merge and advisory.
 *
 * The shape matters more than usual here, because each way of getting it wrong
 * is silent:
 *   - inside Build & Test, a multi-minute job lengthens every dev-push run, and
 *     that workflow's per-ref concurrency then supersedes more pending runs, so
 *     fewer dev commits get a build verdict at all;
 *   - inside Build & Test, a red integration run also fires CI Auto-Fix
 *     (`workflow_run` on "Build & Test"), i.e. a Claude push to dev per flake;
 *   - two runs on the shared test machine at once overwrite each other's
 *     checkout, server and runner;
 *   - a check whose name the release gate does not recognise as advisory turns
 *     the release PR (head = the same dev SHA) red for the release executor.
 */

const y = (f: string): any => Bun.YAML.parse(readFileSync(f, 'utf8'));
const triggers = (w: any) => w.on ?? w[true as unknown as string];

const BUILD = '.github/workflows/build.yml';
const REUSABLE = '.github/workflows/integration.yml';
const POST_MERGE = '.github/workflows/post-merge-integration.yml';

describe('reusable integration workflow', () => {
  const wf = y(REUSABLE);
  const job = wf.jobs.integration;

  test('is callable only, so it never runs on its own trigger', () => {
    expect(Object.keys(triggers(wf))).toEqual(['workflow_call']);
  });

  test('serialises every caller on the shared test machine, without cancelling a running job', () => {
    expect(job.concurrency).toEqual({ group: 'integration-test-machine', 'cancel-in-progress': false });
  });

  test('takes what it runs from inputs, not from a caller job it cannot see', () => {
    const text = readFileSync(REUSABLE, 'utf8');
    expect(text).not.toContain('needs.changes');
    for (const k of ['api', 'runner', 'e2e', 'neon_branch', 'checkout_sha']) {
      expect(wf.on?.workflow_call?.inputs ?? triggers(wf).workflow_call.inputs).toHaveProperty(k);
    }
  });

  test('E2E is gated on the e2e input', () => {
    const e2e = job.steps.find((s: any) => s.name === 'E2E tests');
    expect(e2e.if).toContain('inputs.e2e');
  });

  test('tests the exact SHA it was given, not whatever the branch points at by then', () => {
    const sync = job.steps.find((s: any) => s.id === 'sync');
    expect(sync.env.CHECKOUT_SHA).toBe('${{ inputs.checkout_sha }}');
    expect(sync.run).toContain('CHECKOUT_SHA');
  });
});

describe('Build & Test keeps the PR-path integration run', () => {
  const job = y(BUILD).jobs.integration;
  test('calls the reusable workflow with secrets inherited', () => {
    expect(job.uses).toBe('./.github/workflows/integration.yml');
    expect(job.secrets).toBe('inherit');
  });
  test('same gate as before: hotfix PRs into main, never the release PR', () => {
    expect(job.needs).toBe('changes');
    expect(job.if).toContain("github.head_ref != 'dev'");
    expect(y(BUILD).jobs.changes.if).toContain("github.base_ref == 'main'");
  });
});

describe('post-merge integration on dev', () => {
  const wf = y(POST_MERGE);

  test('is its own workflow, so CI Auto-Fix and Build & Test concurrency never see it', () => {
    expect(wf.name).not.toBe('Build & Test');
    expect(triggers(wf).push.branches).toEqual(['dev']);
    const ciFix = y('.github/workflows/ci-fix.yml');
    expect(triggers(ciFix).workflow_run.workflows).not.toContain(wf.name);
  });

  test('lets a newer dev head supersede a pending run but never kills a running one', () => {
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });

  test('runs API tests only, against the pushed SHA', () => {
    const job = wf.jobs.integration;
    expect(job.uses).toBe('./.github/workflows/integration.yml');
    expect(job.secrets).toBe('inherit');
    expect(job.with.checkout_sha).toBe('${{ github.sha }}');
    expect(String(job.with.e2e)).toBe('false');
    expect(String(job.with.runner)).toBe('false');
  });

  test("its check name is the one the release gate treats as advisory", () => {
    expect(POST_MERGE_INTEGRATION_CHECK_PREFIX).toBeTruthy();
    const name: string = wf.jobs.integration.name;
    expect(name.toLowerCase().startsWith(POST_MERGE_INTEGRATION_CHECK_PREFIX)).toBe(true);
  });

  test('diffs against main — what the release would ship — not the previous push', () => {
    const detect = wf.jobs.changes.steps.find((s: any) => s.id === 'filter');
    expect(detect.run).toContain('origin/main...HEAD');
  });
});
