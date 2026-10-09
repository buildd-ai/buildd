/**
 * Adversarial probe, lens 3 (GitHub semantics): behaviour real GitHub has and
 * the fake GitHub omits, and whether the kernel (and the doors that feed it)
 * mishandle it. Each test states the GitHub behaviour it models; a fake gap is
 * closed in-test (a wrapped `request`, `failNext`) rather than in the fake.
 *
 * A failing test here is a probe finding, not a regression in the suite.
 *
 * Every finding test asserts the CORRECT behaviour and is marked `test.failing`
 * because it fails on dev today (probe task e769323f). Bun reports a
 * `test.failing` that starts passing as a failure, so the PR that fixes a
 * finding must turn its test(s) back into plain `test`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { q } from './harness';
import { seam, world, type World, type OpenedPr } from './workflow-scenarios-world';

const { landPr } = await import('../../src/lib/pr-landing');

let w: World;
afterEach(() => w?.dispose());

/** The landing sweep's call for one PR (what the cron does for an APPROVED kernel delivery). */
const sweep = (w: World, pr: OpenedPr) => landPr({
  workspaceId: w.workspaceId, installationId: w.installationId, repoFullName: w.repo, prNumber: pr.prNumber, eventHeadSha: null,
  door: 'sweep', actor: { kind: 'system' }, mode: 'enforce', policy: { tier: 'auto-threshold' }, owner: { taskId: pr.ownerTaskId, workerId: pr.workerId },
});

/** Approve at the head with `build` green, then report `test` with `conclusion`/`status` at the same head. */
async function approvedThenCheck(w: World, branch: string, s: { conclusion?: any; status?: any }): Promise<OpenedPr> {
  const pr = await w.openPr({ branch, files: { 'src/a.ts': 'export const a = 2;\n' } });
  await w.handOn(pr);
  w.gh.setCheck(w.repo, pr.head, 'build', { conclusion: 'success' });
  // A second workflow's run on the same head (GitHub Actions: one suite per workflow).
  w.gh.setCheck(w.repo, pr.head, 'test', { ...s, workflow: 'Tests' });
  await w.deliver();
  const r = await w.verdict(pr, await w.reviewer(pr), 'approve', pr.head);
  expect(r).toMatchObject({ handled: true, toState: 'APPROVED' });
  await w.deliver();
  return pr;
}

describe('controls (the harness can tell a red or running check from a green one)', () => {
  test('control: approved at H; test fails → the sweep does not merge', async () => {
    w = await world();
    const pr = await approvedThenCheck(w, 'feat/control-failure', { conclusion: 'success' });
    // A re-run of test fails at the same head; its webhook is lost, so the sweep is the floor.
    w.gh.setCheck(w.repo, pr.head, 'test', { conclusion: 'failure', workflow: 'Tests' });
    w.gh.discardWebhooks();
    await sweep(w, pr);
    expect(w.gh.pr(w.repo, pr.prNumber).merged).toBe(false);
  });
  test('control: approved at H; test in_progress → the sweep does not merge', async () => {
    w = await world();
    const pr = await approvedThenCheck(w, 'feat/control-running', { status: 'in_progress' });
    await sweep(w, pr);
    expect(w.gh.pr(w.repo, pr.prNumber).merged).toBe(false);
  });
  test('control: approved at H; test success → the sweep merges', async () => {
    w = await world();
    const pr = await approvedThenCheck(w, 'feat/control-green', { conclusion: 'success' });
    expect((await sweep(w, pr)).kind).toBe('merged');
  });
});

describe('check-run conclusions and statuses other than success/failure', () => {
  // GitHub: a check run's conclusion is one of action_required, cancelled, failure, neutral,
  // success, skipped, stale, timed_out (+ startup_failure for Actions); branch protection
  // treats only success/neutral/skipped as passing.
  // https://docs.github.com/en/rest/checks/runs#get-a-check-run
  for (const conclusion of ['timed_out', 'cancelled', 'startup_failure', 'action_required']) {
    test(`approved at H; the test job ends ${conclusion} → the landing sweep must not merge H`, async () => {
      w = await world();
      const pr = await approvedThenCheck(w, `feat/concl-${conclusion}`, { conclusion });
      const o = await sweep(w, pr);
      expect(w.gh.pr(w.repo, pr.prNumber).merged).toBe(false);
      expect(o.kind).not.toBe('merged');
    });
  }

  // GitHub: check run status is queued | in_progress | completed | waiting | requested | pending
  // ("waiting", "requested" and "pending" are GitHub Actions only: a job waiting on an
  // environment protection rule or a concurrency group). https://docs.github.com/en/rest/checks/runs
  for (const status of ['waiting', 'pending', 'requested']) {
    test(`approved at H; the test job is ${status} (not started) → the landing sweep must not merge H`, async () => {
      w = await world();
      const pr = await approvedThenCheck(w, `feat/status-${status}`, { status });
      const o = await sweep(w, pr);
      expect(w.gh.pr(w.repo, pr.prNumber).merged).toBe(false);
      expect(o.kind).not.toBe('merged');
    });
  }
});

describe('check-runs pagination', () => {
  // GitHub: GET /commits/{ref}/check-runs pages at per_page (default 30, max 100).
  // https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference
  test('approved at H with 31 check runs, the one that failed is on page 2 → the landing sweep must not merge H', async () => {
    w = await world();
    const gh = w.gh as unknown as { request: (m: string, p: string, b?: unknown) => Promise<{ status: number; body: any }> };
    const original = gh.request.bind(gh);
    gh.request = async (m, p, b) => {
      const res = await original(m, p, b);
      if (m.toUpperCase() === 'GET' && /\/commits\/[^/]+\/check-runs/.test(p) && res.status === 200) {
        const qs = new URLSearchParams(p.split('?')[1] ?? '');
        const per = Math.min(Number(qs.get('per_page') ?? 30), 100);
        const page = Number(qs.get('page') ?? 1);
        res.body = { ...res.body, check_runs: res.body.check_runs.slice((page - 1) * per, page * per) };
      }
      return res;
    };
    const pr = await w.openPr({ branch: 'feat/many-checks', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    for (let i = 0; i < 30; i++) w.gh.setCheck(w.repo, pr.head, `matrix-${String(i).padStart(2, '0')}`, { conclusion: 'success' });
    await w.deliver();
    const r = await w.verdict(pr, await w.reviewer(pr), 'approve', pr.head);
    expect(r).toMatchObject({ handled: true, toState: 'APPROVED' });
    // The 31st run fails (the world's ingest files a CI fix for a red suite; a sweep tick that
    // reads only page 1 sees a fully green commit).
    w.gh.discardWebhooks();
    w.gh.setCheck(w.repo, pr.head, 'e2e', { conclusion: 'failure', workflow: 'E2E' });
    w.gh.discardWebhooks(); // the check_suite webhook is lost: the sweep is the floor
    const o = await sweep(w, pr);
    expect(w.gh.pr(w.repo, pr.prNumber).merged).toBe(false);
    expect(o.kind).not.toBe('merged');
  });
});

describe('legacy commit statuses', () => {
  // GitHub: CI that reports through the Statuses API (Jenkins, CircleCI, Buildkite, Vercel's
  // status contexts) never creates check runs; GET /commits/{ref}/status is the combined state,
  // and a failing non-required context makes mergeable_state "unstable" (merge still allowed).
  // https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference
  test('approved at H; CI reports only a failing commit status (no check runs) → the landing sweep must not merge H', async () => {
    w = await world();
    const gh = w.gh as unknown as { request: (m: string, p: string, b?: unknown) => Promise<{ status: number; body: any }> };
    const original = gh.request.bind(gh);
    gh.request = async (m, p, b) => {
      const res = await original(m, p, b);
      if (m.toUpperCase() === 'GET' && /\/commits\/([^/]+)\/status$/.test(p.split('?')[0]) && res.status === 200) {
        res.body = { ...res.body, state: 'failure', total_count: 1, statuses: [{ context: 'ci/jenkins', state: 'failure', description: 'Build failed' }] };
      }
      if (m.toUpperCase() === 'GET' && /\/pulls\/\d+$/.test(p.split('?')[0]) && res.status === 200 && res.body?.mergeable_state === 'clean') {
        res.body = { ...res.body, mergeable_state: 'unstable' };
      }
      return res;
    };
    const pr = await w.openPr({ branch: 'feat/status-only-ci', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    const r = await w.verdict(pr, await w.reviewer(pr), 'approve', pr.head);
    expect(r).toMatchObject({ handled: true, toState: 'APPROVED' });
    await w.deliver();
    const o = await sweep(w, pr);
    expect({ kind: o.kind, merged: w.gh.pr(w.repo, pr.prNumber).merged }).toMatchObject({ merged: false });
  });
});

describe('merge-call refusals that are transient', () => {
  // GitHub: a secondary rate limit answers 403 or 429 with a JSON message (and retry-after);
  // merging is a content-creating request subject to it.
  // https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits
  const cases: Array<[number, string]> = [
    [403, 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.'],
    [429, 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.'],
    [403, 'API rate limit exceeded for installation ID 1.'],
    [500, 'Server Error'],
  ];
  for (const [status, message] of cases) {
    test.failing(`approved at H; PUT /merge answers ${status} "${message.slice(0, 40)}" → not a person's problem: the delivery stays landable (not ESCALATED)`, async () => {
      w = await world();
      const pr = await w.openPr({ branch: `feat/ratelimit-${status}-${message.length}`, files: { 'src/a.ts': 'export const a = 2;\n' } });
      await w.approve(pr);
      w.gh.failNext(/^PUT \/repos\/.*\/pulls\/\d+\/merge$/, status, message);
      const landed = await w.land(pr, pr.head);
      expect(landed.merged).toBe(false);
      expect(w.mergeCalls(pr).map((c) => c.status)).toEqual([status]);
      const d = await w.delivery(pr);
      expect({ state: d.state, reason: d.stateReason }).not.toEqual({ state: 'ESCALATED', reason: 'landing_needs_human' });
      // And the next door lands it once GitHub answers again.
      expect(await w.land(pr, pr.head)).toMatchObject({ merged: true });
    });
  }
});

describe('draft PRs', () => {
  // GitHub: a draft PR cannot be merged (PUT /merge → 405); converted_to_draft / ready_for_review
  // are pull_request actions. https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request
  test.failing('approved at H; a person converts the PR to draft to hold it, then marks it ready → the PR lands without a person resolving an escalation', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/draft-hold', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    (w.gh.pr(w.repo, pr.prNumber) as { draft: boolean }).draft = true;
    const held = await sweep(w, pr);
    expect(w.gh.pr(w.repo, pr.prNumber).merged).toBe(false);
    const [mcr] = await q<{ outcome: string; detail: string }>(sql`SELECT evidence->>'outcome' AS outcome, evidence->>'detail' AS detail FROM workflow_transitions
      WHERE delivery_id = ${pr.deliveryId}::uuid AND command = 'MergeCallResult' ORDER BY to_version DESC LIMIT 1`);
    (w.gh.pr(w.repo, pr.prNumber) as { draft: boolean }).draft = false;
    const after = await sweep(w, pr);
    expect({ mcr, calls: w.mergeCalls(pr).map((c) => c.status), held: held.kind, after: after.kind, state: (await w.delivery(pr)).state, merged: w.gh.pr(w.repo, pr.prNumber).merged })
      .toMatchObject({ after: 'merged', state: 'MERGED', merged: true });
  });
});

describe('base retarget', () => {
  // GitHub: deleting a merged PR's head branch retargets open PRs based on it to the merged
  // PR's base (pull_request.edited with changes.base). It does NOT close them.
  // https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/changing-the-base-branch-of-a-pull-request
  test('B is stacked on A; A merges and its branch is deleted, GitHub retargets B to dev; dev then goes red on lint and B fails lint with it → B is BLOCKED_ON_TRUNK with dev\'s incident, no per-PR CI fix', async () => {
    w = await world();
    const a = await w.openPr({ branch: 'feat/stack-a', files: { 'src/a.ts': 'export const a = 2;\n' } });
    const b = await w.openPr({ branch: 'feat/stack-b', base: 'feat/stack-a', files: { 'src/c.ts': 'export const c = 2;\n' } });
    await w.handOn(b);
    await w.approve(a);
    expect(await w.land(a, a.head)).toMatchObject({ merged: true });
    await w.deliver();
    // GitHub's retarget: B's base becomes dev (the fake's PATCH base), then the head branch goes.
    await w.gh.request('PATCH', `/repos/${w.repo}/pulls/${b.prNumber}`, { base: 'dev' });
    expect(w.gh.pr(w.repo, b.prNumber)).toMatchObject({ state: 'open', baseRef: 'dev' });
    w.gh.discardWebhooks();

    const devHead = w.gh.branchHead(w.repo, 'dev')!;
    w.gh.setCheck(w.repo, devHead, 'lint', { conclusion: 'failure' });
    w.gh.setCheck(w.repo, b.head, 'lint', { conclusion: 'failure' });
    await w.deliver();
    const d = await w.delivery(b);
    const incidents = await q<{ base_ref: string }>(sql`SELECT base_ref FROM trunk_incidents WHERE workspace_id = ${w.workspaceId}::uuid`);
    expect({ state: d.state, baseRef: d.baseRef, incidentBases: incidents.map((i) => i.base_ref), ciFixes: (await w.tasksOf(b, 'ci_fix')).length })
      .toEqual({ state: 'BLOCKED_ON_TRUNK', baseRef: 'dev', incidentBases: ['dev'], ciFixes: 0 });
  });
});
describe('base retarget changes the diff under an approval', () => {
  // GitHub: PATCH /pulls/{n} {base} (or the UI's "Edit" base) keeps the head SHA and recomputes
  // the PR's diff against the new base; it sends pull_request.edited with changes.base.ref.from.
  // https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request
  test('PR into dev approved at H; a person retargets it to release, where H also carries an unreviewed dev commit → the approval must not land H into release unreviewed', async () => {
    w = await world();
    w.gh.createBranch(w.repo, 'release');
    // dev moves on with someone else's change; the PR branches from dev after it.
    w.gh.advanceBase(w.repo, 'dev', { 'src/unreviewed.ts': 'export const risky = true;\n' });
    await w.deliver();
    const pr = await w.openPr({ branch: 'feat/retarget-release', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.approve(pr);
    await w.gh.request('PATCH', `/repos/${w.repo}/pulls/${pr.prNumber}`, { base: 'release' });
    expect(w.gh.pr(w.repo, pr.prNumber)).toMatchObject({ baseRef: 'release', headSha: pr.head });
    const o = await sweep(w, pr);
    const d = await w.delivery(pr);
    expect({ kind: o.kind, state: d.state, releaseGotUnreviewed: 'src/unreviewed.ts' in w.gh.files(w.repo, 'release') })
      .toMatchObject({ releaseGotUnreviewed: false });
  });
});
void seam;
