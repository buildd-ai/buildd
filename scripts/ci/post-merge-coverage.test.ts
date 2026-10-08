import { describe, test, expect } from 'bun:test';
import {
  classifyPaths,
  decide,
  evidenceFromJobs,
  INTEGRATION_JOB_NAME,
  type DecideInput,
  type PriorRun,
  type RunEvidence,
} from './post-merge-coverage';

/**
 * A linear dev history, oldest first, plus the runs recorded against it. Each
 * commit lists the files it touched; `changedSince` unions them, which is what
 * a tree diff of a linear history without reverts returns.
 */
function history(commits: Array<{ sha: string; files: string[] }>) {
  const idx = (sha: string) => commits.findIndex((c) => c.sha === sha);
  return {
    isAncestor: (sha: string, of = commits[commits.length - 1].sha) => {
      const a = idx(sha);
      return a >= 0 && a <= idx(of);
    },
    changedSince: (base: string, head = commits[commits.length - 1].sha) => {
      const a = idx(base);
      if (a < 0) return null;
      return [...new Set(commits.slice(a + 1, idx(head) + 1).flatMap((c) => c.files))];
    },
  };
}

const run = (id: number, sha: string): PriorRun => ({ id, sha, url: `https://example.test/runs/${id}` });

function input(
  commits: Array<{ sha: string; files: string[] }>,
  runs: Array<[PriorRun, RunEvidence]>,
  over: Partial<DecideInput> = {},
): DecideInput {
  const h = history(commits);
  const head = commits[commits.length - 1].sha;
  const ev = new Map(runs.map(([r, e]) => [r.id, e]));
  return {
    event: 'push',
    headSha: head,
    devHeadSha: head,
    // newest first, as the API returns them
    runs: runs.map(([r]) => r).reverse(),
    isAncestor: h.isAncestor,
    evidence: (r) => ev.get(r.id) ?? null,
    changedSince: (b) => h.changedSince(b),
    ...over,
  };
}

const PASS: RunEvidence = { api: true, runner: false };
const PASS_RUNNER: RunEvidence = { api: true, runner: true };
// A successful workflow run whose integration job was skipped: not evidence.
const SKIPPED: RunEvidence = { api: false, runner: false };

describe('decide', () => {
  test('doc push after an already-covered server commit does not re-request the run', async () => {
    const d = await decide(
      input(
        [
          { sha: 'a0', files: ['apps/runner/src/x.ts'] },
          { sha: 's1', files: ['apps/web/src/app/api/x/route.ts'] },
          { sha: 'd1', files: ['docs/notes.md'] },
          { sha: 'd2', files: ['README.md'] },
        ],
        [
          [run(1, 'a0'), PASS_RUNNER],
          [run(2, 's1'), PASS],
          [run(3, 'd1'), SKIPPED],
        ],
      ),
    );
    expect(d).toMatchObject({ api: false, runner: false, reason: 'covered' });
    expect(d.apiBase?.sha).toBe('s1');
    expect(d.runnerBase?.sha).toBe('a0');
  });

  test('an older server change whose run failed stays required on a later doc push', async () => {
    // s1's run failed, so it is absent from the successful-runs list. The doc
    // push on top must not inherit coverage from the docs-only diff.
    const d = await decide(
      input(
        [
          { sha: 'b0', files: ['apps/web/src/a.ts'] },
          { sha: 's1', files: ['packages/core/db/schema.ts'] },
          { sha: 'd1', files: ['docs/x.md'] },
        ],
        [[run(1, 'b0'), PASS_RUNNER]],
      ),
    );
    expect(d).toMatchObject({ api: true, reason: 'changed' });
    expect(d.apiBase?.sha).toBe('b0');
    expect(d.changed).toContain('packages/core/db/schema.ts');
  });

  test('a run that succeeded with its integration job skipped is not evidence', async () => {
    // s1 was skipped (e.g. superseded); d1 is docs. Base must stay at b0.
    const d = await decide(
      input(
        [
          { sha: 'b0', files: [] },
          { sha: 's1', files: ['apps/web/src/a.ts'] },
          { sha: 'd1', files: ['docs/x.md'] },
        ],
        [
          [run(1, 'b0'), PASS_RUNNER],
          [run(2, 's1'), SKIPPED],
        ],
      ),
    );
    expect(d.api).toBe(true);
    expect(d.apiBase?.sha).toBe('b0');
  });

  test('a push dev has already moved past is coalesced into the newer run', async () => {
    const commits = [
      { sha: 'b0', files: [] },
      { sha: 's1', files: ['apps/web/src/a.ts'] },
      { sha: 's2', files: ['apps/web/src/b.ts'] },
      { sha: 's3', files: ['docs/c.md'] },
    ];
    const h = history(commits);
    const older = await decide(
      input(commits, [[run(1, 'b0'), PASS_RUNNER]], {
        headSha: 's1',
        devHeadSha: 's3',
        changedSince: (b) => h.changedSince(b, 's1'),
      }),
    );
    expect(older).toMatchObject({ api: false, reason: 'superseded' });

    // The newest push diffs from the same verified base, so s1's change is in it.
    const newest = await decide(input(commits, [[run(1, 'b0'), PASS_RUNNER]]));
    expect(newest.api).toBe(true);
    expect(newest.changed).toEqual(expect.arrayContaining(['apps/web/src/a.ts', 'apps/web/src/b.ts']));
  });

  test('the newest dev head is never superseded by itself', async () => {
    const d = await decide(
      input([{ sha: 'b0', files: [] }, { sha: 's1', files: ['apps/web/src/a.ts'] }], [[run(1, 'b0'), PASS_RUNNER]]),
    );
    expect(d.reason).toBe('changed');
  });

  test('a passing run on a SHA outside this history is not evidence (SHA mismatch)', async () => {
    const d = await decide(
      input(
        [
          { sha: 'b0', files: [] },
          { sha: 's1', files: ['apps/web/src/a.ts'] },
          { sha: 'd1', files: ['docs/x.md'] },
        ],
        [
          [run(1, 'b0'), PASS_RUNNER],
          // e.g. a run on a rewritten or other-branch commit that never reached dev
          [run(2, 'zz-not-on-dev'), PASS_RUNNER],
        ],
      ),
    );
    expect(d.api).toBe(true);
    expect(d.apiBase?.sha).toBe('b0');
  });

  test('a manual run always tests, runner included, even with nothing changed', async () => {
    const d = await decide(
      input([{ sha: 'b0', files: [] }], [[run(1, 'b0'), PASS_RUNNER]], { event: 'workflow_dispatch' }),
    );
    expect(d).toMatchObject({ api: true, runner: true, reason: 'manual' });
  });

  test('fails closed: no runs listed, no passing ancestor, or no diff', async () => {
    const commits = [{ sha: 'b0', files: [] }, { sha: 'd1', files: ['docs/x.md'] }];
    expect(await decide(input(commits, [], { runs: null }))).toMatchObject({ api: true, runner: true, reason: 'no-evidence' });
    expect(await decide(input(commits, [[run(1, 'b0'), SKIPPED]]))).toMatchObject({ api: true, runner: true, reason: 'no-evidence' });
    expect(
      await decide(input(commits, [[run(1, 'b0'), PASS_RUNNER]], { changedSince: () => null })),
    ).toMatchObject({ api: true, runner: true, reason: 'diff-failed' });
  });

  test('stops reading evidence past the lookup cap, and then tests', async () => {
    const commits = [{ sha: 'b0', files: [] }, ...Array.from({ length: 5 }, (_, i) => ({ sha: `d${i}`, files: ['docs/x.md'] }))];
    const runs: Array<[PriorRun, RunEvidence]> = [[run(1, 'b0'), PASS_RUNNER], ...commits.slice(1, 5).map((c, i) => [run(i + 2, c.sha), SKIPPED] as [PriorRun, RunEvidence])];
    expect((await decide(input(commits, runs, { maxLookups: 3 }))).reason).toBe('no-evidence');
    expect((await decide(input(commits, runs))).reason).toBe('covered');
  });

  test('runner changes are judged against the last run that actually started the runner', async () => {
    const d = await decide(
      input(
        [
          { sha: 'r0', files: [] },
          { sha: 'r1', files: ['apps/runner/src/workers.ts'] },
          { sha: 's2', files: ['apps/web/src/a.ts'] },
          { sha: 'd3', files: ['docs/x.md'] },
        ],
        [
          [run(1, 'r0'), PASS_RUNNER],
          // s2 ran API-only, so r1's runner change is still unverified
          [run(2, 's2'), PASS],
        ],
      ),
    );
    expect(d).toMatchObject({ api: true, runner: true, reason: 'changed' });
    expect(d.apiBase?.sha).toBe('s2');
    expect(d.runnerBase?.sha).toBe('r0');
  });

  test('with no runner-verified base at all, the runner is tested', async () => {
    const d = await decide(
      input([{ sha: 'b0', files: [] }, { sha: 'd1', files: ['docs/x.md'] }], [[run(1, 'b0'), PASS]]),
    );
    expect(d).toMatchObject({ api: true, runner: true });
  });

  test('a change reverted before the head is not a change (tree diff)', async () => {
    const d = await decide(
      input([{ sha: 'b0', files: [] }, { sha: 'd1', files: ['docs/x.md'] }], [[run(1, 'b0'), PASS_RUNNER]], {
        changedSince: () => ['docs/x.md'],
      }),
    );
    expect(d.reason).toBe('covered');
  });
});

describe('classifyPaths', () => {
  test.each([
    ['apps/web/src/app/api/workers/claim/route.ts', true, false],
    ['apps/web/package.json', true, false],
    ['apps/web/tests/integration/concurrency.test.ts', true, false],
    ['packages/core/drizzle/0123_x.sql', true, false],
    ['packages/shared/src/types.ts', true, false],
    ['packages/dispatch-contract/src/index.ts', true, false],
    ['bun.lock', true, false],
    ['package.json', true, false],
    ['scripts/seed-integration-fixtures.ts', true, false],
    ['apps/runner/src/workers.ts', false, true],
    ['.github/workflows/integration.yml', true, true],
    ['.github/workflows/post-merge-integration.yml', true, true],
    ['scripts/ci/post-merge-coverage.ts', true, true],
    ['docs/specs/release-flow.md', false, false],
    ['README.md', false, false],
    ['.github/workflows/visual-qa.yml', false, false],
    ['apps/runner-docs.md', false, false],
  ])('%s → api=%p runner=%p', (f, api, runner) => {
    expect(classifyPaths([f])).toEqual({ api, runner });
  });
});

describe('evidenceFromJobs', () => {
  const job = (conclusion: string, steps: Record<string, string>) => ({
    name: INTEGRATION_JOB_NAME,
    conclusion,
    steps: Object.entries(steps).map(([name, c]) => ({ name, conclusion: c })),
  });

  test('passing integration job with the tests step run is API evidence', () => {
    expect(evidenceFromJobs([job('success', { 'Integration tests': 'success', 'Start preview runner': 'skipped' })])).toEqual(PASS);
    expect(evidenceFromJobs([job('success', { 'Integration tests': 'success', 'Start preview runner': 'success' })])).toEqual(PASS_RUNNER);
  });

  test('skipped, failed or missing integration is not evidence', () => {
    expect(evidenceFromJobs([job('skipped', {})])).toEqual(SKIPPED);
    expect(evidenceFromJobs([job('failure', { 'Integration tests': 'failure' })])).toEqual(SKIPPED);
    expect(evidenceFromJobs([job('cancelled', {})])).toEqual(SKIPPED);
    expect(evidenceFromJobs([{ name: 'post-merge integration / changes', conclusion: 'success' }])).toEqual(SKIPPED);
    // a green job whose test step never ran (e.g. machine offline gating) is not coverage
    expect(evidenceFromJobs([job('success', { 'Integration tests': 'skipped' })])).toEqual(SKIPPED);
  });
});
