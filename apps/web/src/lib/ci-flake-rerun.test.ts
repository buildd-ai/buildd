import { describe, it, expect } from 'bun:test';
import { rerunIfKnownFlake, knownFlakeJobs, flakyTestsOf, flakeSignature, type FlakeRerunDeps, type FlakeRerunInput } from './ci-flake-rerun';
import type { RedCheckRecord, RedJob } from './red-check-cause';

const WINDOWS = 'Runner unit tests (windows)';
const DIGEST = [
  '1 of 414 unit test files failed:',
  'apps/runner/__tests__/unit/cloud-in-clone.test.ts',
  '  x cloud rejects a diverged resume candidate and uses the default base',
].join('\n');

const flakyJob: RedJob = { name: WINDOWS, step: 'Run runner unit tests', lines: DIGEST, rule: 'unrelated_to_diff', baseGreen: true };

function record(over: Partial<RedCheckRecord> = {}): RedCheckRecord {
  return { headSha: 'abc1234def', runId: 9, runAttempt: 1, at: 't', jobs: [flakyJob], cause: 'flake', signature: 's', ...over };
}

const input: FlakeRerunInput = { installationId: 1, repoFullName: 'o/r', prNumber: 5619, headSha: 'abc1234def', workspaceId: 'ws1' };

function deps(rec: RedCheckRecord | null, open: Record<string, string> = {}) {
  const log = { reruns: [] as number[], filed: [] as any[], appended: [] as Array<{ id: string; text: string }> };
  const d: FlakeRerunDeps = {
    read: async () => rec,
    rerunFailedJobs: async (_i, runId) => { log.reruns.push(runId); },
    findOpenBug: async (_ws, sig) => (open[sig] ? { id: open[sig] } : null),
    appendToBug: async (id, text) => { log.appended.push({ id, text }); },
    fileBug: async (row) => { log.filed.push(row); return { id: `bug-${log.filed.length}` }; },
  };
  return { d, log };
}

const SIG = flakeSignature(WINDOWS, 'apps/runner/__tests__/unit/cloud-in-clone.test.ts', 'cloud rejects a diverged resume candidate and uses the default base');

describe('knownFlakeJobs', () => {
  it('needs every failed job unrelated to the diff and not red on the base', () => {
    expect(knownFlakeJobs(record())).toHaveLength(1);
    expect(knownFlakeJobs(record({ jobs: [] }))).toBeNull();
    // No base run compared: not known to pass on the base.
    expect(knownFlakeJobs(record({ jobs: [{ ...flakyJob, baseGreen: undefined }] }))).toBeNull();
    // Red on the base is a trunk incident, not this PR's flake.
    expect(knownFlakeJobs(record({ jobs: [{ ...flakyJob, rule: 'red_on_base', baseGreen: false }] }))).toBeNull();
    // The diff touches what the job tests: a real failure until shown otherwise.
    expect(knownFlakeJobs(record({ jobs: [{ ...flakyJob, rule: 'test' }] }))).toBeNull();
    // One real failure beside the flake: the PR still needs a fix.
    expect(knownFlakeJobs(record({ jobs: [flakyJob, { name: 'build · unit tests (1/3)', step: null, lines: '(fail) a > b', rule: 'test', baseGreen: true }] }))).toBeNull();
  });
});

describe('flakyTestsOf', () => {
  it('one entry per failing test, under the file the digest names above it', () => {
    expect(flakyTestsOf([flakyJob])).toEqual([{
      job: WINDOWS,
      file: 'apps/runner/__tests__/unit/cloud-in-clone.test.ts',
      test: 'cloud rejects a diverged resume candidate and uses the default base',
      signature: SIG,
    }]);
  });

  it('reads bun (fail) lines without their timing, and the bare job when no test is named', () => {
    const bun = flakyTestsOf([{ ...flakyJob, lines: '(fail) suite > case [12.3ms]' }]);
    expect(bun.map(t => t.test)).toEqual(['suite > case']);
    expect(bun[0].signature).toBe('ci-flake:runner unit tests (windows)::::suite > case');
    const bare = flakyTestsOf([{ ...flakyJob, lines: '##[error]Process completed with exit code 1.' }]);
    expect(bare).toEqual([{ job: WINDOWS, file: null, test: null, signature: 'ci-flake:runner unit tests (windows)' }]);
  });

  it('the signature is stable across runs of the same test', () => {
    const a = flakyTestsOf([{ ...flakyJob, lines: '(fail) suite > case [12.3ms]' }])[0].signature;
    const b = flakyTestsOf([{ ...flakyJob, lines: '(fail) suite > case [4000ms]' }])[0].signature;
    expect(a).toBe(b);
  });
});

describe('rerunIfKnownFlake', () => {
  it('re-runs the failed jobs once and files one friction task per flaky test', async () => {
    const { d, log } = deps(record());
    const out = await rerunIfKnownFlake(input, d, new Date('2026-10-24T10:00:00Z'));
    expect(out).toMatchObject({ rerun: true, runId: 9, runAttempt: 1, friction: [{ signature: SIG, taskId: 'bug-1', outcome: 'created' }] });
    expect(log.reruns).toEqual([9]);
    expect(log.filed).toHaveLength(1);
    expect(log.filed[0]).toMatchObject({ workspaceId: 'ws1', signature: SIG });
    expect(log.filed[0].title).toStartWith('[friction] flaky test: cloud rejects a diverged resume candidate');
    expect(log.filed[0].description).toContain('PR #5619 @ abc1234def');
    expect(log.filed[0].description).toContain('https://github.com/o/r/actions/runs/9');
  });

  it('a test that recurs on another PR appends to its open friction task', async () => {
    const { d, log } = deps(record(), { [SIG]: 'open-1' });
    const out = await rerunIfKnownFlake({ ...input, prNumber: 5633 }, d);
    expect(out).toMatchObject({ rerun: true, friction: [{ taskId: 'open-1', outcome: 'appended' }] });
    expect(log.filed).toEqual([]);
    expect(log.appended[0].id).toBe('open-1');
    expect(log.appended[0].text).toContain('PR #5633');
  });

  it('a head already re-run once goes to the normal fix path', async () => {
    const { d, log } = deps(record({ runAttempt: 2 }));
    expect(await rerunIfKnownFlake(input, d)).toEqual({ rerun: false, reason: 'attempts_exhausted' });
    expect(log.reruns).toEqual([]);
    expect(log.filed).toEqual([]);
  });

  it('leaves anything that is not a known flake alone', async () => {
    const { d, log } = deps(record({ jobs: [{ ...flakyJob, rule: 'test' }] }));
    expect(await rerunIfKnownFlake(input, d)).toEqual({ rerun: false, reason: 'not_flake' });
    expect(log.reruns).toEqual([]);
    expect(await rerunIfKnownFlake(input, deps(null).d)).toEqual({ rerun: false, reason: 'no_record' });
  });

  it('a re-run GitHub refuses falls through to the fix path and files nothing', async () => {
    const { d, log } = deps(record());
    d.rerunFailedJobs = async () => { throw new Error('403'); };
    expect(await rerunIfKnownFlake(input, d)).toEqual({ rerun: false, reason: 'rerun_failed' });
    expect(log.filed).toEqual([]);
  });

  it('a friction write that fails never undoes the re-run', async () => {
    const { d } = deps(record());
    d.fileBug = async () => { throw new Error('db down'); };
    expect(await rerunIfKnownFlake(input, d)).toMatchObject({ rerun: true, friction: [] });
  });
});
