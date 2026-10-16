import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { INTEGRATION_JOB_NAME, INTEGRATION_TESTS_STEP, RUNNER_STEP } from './ci/post-merge-coverage';

// Read, not imported: dispatch.ts pulls in the GitHub client and its env.
const POST_MERGE_INTEGRATION_CHECK_PREFIX = /POST_MERGE_INTEGRATION_CHECK_PREFIX = '([^']+)'/.exec(
  readFileSync('apps/web/src/lib/release/dispatch.ts', 'utf8'),
)?.[1] as string;
const CANDIDATE_INTEGRATION_CHECK_NAME = /CANDIDATE_INTEGRATION_CHECK_NAME = '([^']+)'/.exec(
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

  test('tests one exact SHA, on both checkouts, and fails if the machine checked out anything else', () => {
    const target = job.steps.find((s: any) => s.id === 'target');
    // A PR event's own SHA is the merge ref, so the PR head is the default there.
    expect(target.env.REQUESTED).toBe('${{ inputs.checkout_sha || github.event.pull_request.head.sha || github.sha }}');
    expect(target.run).toContain('[0-9a-f]{40}');
    expect(job.steps.findIndex((s: any) => s.id === 'target')).toBe(0);

    // This job's checkout supplies the tests, migrations and fixtures.
    const checkout = job.steps.find((s: any) => String(s.uses).startsWith('actions/checkout'));
    expect(checkout.with.ref).toBe('${{ steps.target.outputs.sha }}');

    // The test machine's checkout supplies the server.
    const sync = job.steps.find((s: any) => s.id === 'sync');
    expect(sync.env.CHECKOUT_SHA).toBe('${{ steps.target.outputs.sha }}');
    expect(sync.run).toContain('fetch --depth 1 origin $CHECKOUT_SHA');
    expect(sync.run).toContain('rev-parse HEAD) = $CHECKOUT_SHA');
    // never by branch name: a branch tip moves between the event and the job
    expect(sync.run).not.toContain('--branch');

    expect(triggers(wf).workflow_call.outputs.tested_sha.value).toBe('${{ jobs.integration.outputs.tested_sha }}');
    expect(job.outputs.tested_sha).toBe('${{ steps.target.outputs.sha }}');
  });

  test('refuses a call that would run nothing and report green', () => {
    const target = job.steps.find((s: any) => s.id === 'target');
    expect(target.run).toContain('nothing would run');
  });

  test('always records evidence: source, tested SHA, check, what ran, verdict', () => {
    const ev = job.steps.find((s: any) => s.name === 'Record integration evidence');
    expect(ev.if).toBe('always()');
    expect(ev.env.SOURCE).toBe('${{ inputs.source }}');
    expect(ev.env.TESTED_SHA).toBe('${{ steps.target.outputs.sha }}');
    for (const k of ['MODE', 'SYNC', 'API_TESTS', 'E2E_TESTS', 'VERDICT', 'RUN_URL']) expect(ev.env).toHaveProperty(k);
    // every caller's check name is spelled out
    expect(ev.run).toContain(CANDIDATE_INTEGRATION_CHECK_NAME);
    expect(ev.run).toContain(INTEGRATION_JOB_NAME);
    expect(ev.run).toContain('"integration / integration"');
  });

  test('a release candidate cannot pass on a skipped E2E suite', () => {
    const e2e = job.steps.find((s: any) => s.name === 'E2E tests');
    expect(e2e.env.SOURCE).toBe('${{ inputs.source }}');
    expect(e2e.run).toMatch(/release-candidate[\s\S]*exit 1/);
  });

  test('the steps the coverage script reads as evidence exist under those names', () => {
    const names = job.steps.map((s: any) => s.name);
    expect(names).toContain(INTEGRATION_TESTS_STEP);
    expect(names).toContain(RUNNER_STEP);
    expect(job.name).toBe('integration');
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
  test('tests the PR head SHA, labelled as hotfix evidence, and leaves candidates to their own job', () => {
    expect(job.with.checkout_sha).toBe('${{ github.event.pull_request.head.sha }}');
    expect(job.with.source).toBe('hotfix-pr');
    expect(job.if).toContain("!startsWith(github.head_ref, 'release/v')");
  });
});

describe('release candidate integration', () => {
  const job = y(BUILD).jobs['candidate-integration'];

  test('runs on candidate PRs into main, unconditionally (no path filter, no earlier green)', () => {
    expect(job.if).toBe("github.event_name == 'pull_request' && github.base_ref == 'main' && startsWith(github.head_ref, 'release/v')");
    expect(job.needs).toBeUndefined();
  });

  test('full API + runner tests on the exact candidate head SHA, through the shared machine queue', () => {
    expect(job.uses).toBe('./.github/workflows/integration.yml');
    expect(job.secrets).toBe('inherit');
    expect(job.with.checkout_sha).toBe('${{ github.event.pull_request.head.sha }}');
    expect(String(job.with.api)).toBe('true');
    expect(String(job.with.runner)).toBe('true');
    expect(job.with.source).toBe('release-candidate');
    // its own Neon branch, never the post-merge one
    expect(job.with.neon_branch).not.toBe(y(POST_MERGE).jobs.integration.with.neon_branch);
  });

  test('its check name is the one the release gate counts, and it is not advisory', () => {
    expect(`${job.name} / ${y(REUSABLE).jobs.integration.name}`).toBe(CANDIDATE_INTEGRATION_CHECK_NAME);
    expect(job.name.toLowerCase().startsWith(POST_MERGE_INTEGRATION_CHECK_PREFIX)).toBe(false);
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

  test('runs API tests, plus the runner when the coverage decision asks, against the pushed SHA', () => {
    const job = wf.jobs.integration;
    expect(job.uses).toBe('./.github/workflows/integration.yml');
    expect(job.secrets).toBe('inherit');
    expect(job.with.checkout_sha).toBe('${{ github.sha }}');
    expect(String(job.with.e2e)).toBe('false');
    expect(String(job.with.api)).toBe('true');
    expect(job.with.runner).toBe("${{ needs.changes.outputs.runner == 'true' }}");
    expect(job.with.source).toBe("${{ github.event_name == 'workflow_dispatch' && 'manual' || 'post-merge-dev' }}");
    expect(job.if).toBe("needs.changes.outputs.api == 'true'");
  });

  test('its integration check-run is the exact name the coverage script reads evidence from', () => {
    expect(`${wf.jobs.integration.name} / ${y(REUSABLE).jobs.integration.name}`).toBe(INTEGRATION_JOB_NAME);
  });

  test('may read its own earlier runs, and nothing more', () => {
    expect(wf.permissions).toEqual({ contents: 'read', actions: 'read' });
  });

  test("its check name is the one the release gate treats as advisory", () => {
    expect(POST_MERGE_INTEGRATION_CHECK_PREFIX).toBeTruthy();
    const name: string = wf.jobs.integration.name;
    expect(name.toLowerCase().startsWith(POST_MERGE_INTEGRATION_CHECK_PREFIX)).toBe(true);
  });

  // Every job in this workflow posts a check-run on the dev SHA that is also
  // the release PR head. One without the prefix (a bare "changes") would count
  // toward the release PR's ciState: pending while it runs, failing if it errs.
  test('every job carries the advisory prefix, not only the integration job', () => {
    for (const [id, job] of Object.entries<any>(wf.jobs)) {
      expect({ id, name: String(job.name ?? id).toLowerCase().startsWith(POST_MERGE_INTEGRATION_CHECK_PREFIX) })
        .toEqual({ id, name: true });
    }
  });

  // It used to diff origin/main...HEAD, so one server change re-requested the
  // full run on every later dev push, docs included, until the next release.
  test('decides from the last verified dev run, with full history, and fails closed', () => {
    const changes = wf.jobs.changes;
    expect(changes.steps[0].with['fetch-depth']).toBe(0);
    const detect = changes.steps.find((s: any) => s.id === 'filter');
    expect(detect.run).not.toContain('origin/main');
    expect(detect.run).toContain('bun run scripts/ci/post-merge-coverage.ts');
    expect(detect.run).toMatch(/if ! bun run[\s\S]*api=true\\nrunner=true/);
    expect(detect.env.GH_TOKEN).toBe('${{ github.token }}');
    expect(changes.outputs.runner).toBe('${{ steps.filter.outputs.runner }}');
  });
});
