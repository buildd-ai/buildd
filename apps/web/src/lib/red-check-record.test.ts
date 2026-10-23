import { describe, it, expect, mock } from 'bun:test';
import { deflateRawSync } from 'zlib';

// No database or GitHub here: readRedChecks takes its GitHub reads injected.
mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@/lib/github', () => ({ githubApi: async () => null, githubApiText: async () => '', getInstallationToken: async () => 't' }));

const { readRedChecks, reportArtifactFor, unzipFirstText, needsJudgement, changedPaths } = await import('./red-check-record');
type Gh = Parameters<typeof readRedChecks>[0];

/** A one-file zip, the shape of an Actions artifact download. */
function zipOf(name: string, text: string): Uint8Array {
  const data = deflateRawSync(Buffer.from(text));
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + n.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + n.length, 12); end.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(Buffer.concat([local, n, data, central, n, end]));
}

const CLEANUP = 'Post job cleanup.\ngit version 2.47.1\nCleaning up orphan processes';

function fakeGithub(opts: { jobs: unknown[]; logs: Record<number, string>; artifacts?: unknown[]; zips?: Record<number, Uint8Array> }): Gh & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async json(path) {
      calls.push(path);
      if (path.includes('/actions/runs?')) return { workflow_runs: [{ id: 7, run_attempt: 1 }] };
      if (path.endsWith('/jobs')) return { jobs: opts.jobs };
      if (path.endsWith('/artifacts')) return { artifacts: opts.artifacts ?? [] };
      return null;
    },
    async text(path) {
      calls.push(path);
      const id = Number(path.match(/jobs\/(\d+)\/logs/)?.[1]);
      return opts.logs[id] ?? '';
    },
    async bytes(path) {
      calls.push(path);
      const id = Number(path.match(/artifacts\/(\d+)\/zip/)?.[1]);
      return opts.zips?.[id] ?? null;
    },
  };
}

const now = () => new Date('2026-10-23T09:00:00Z');

describe('readRedChecks (surface-ia §11)', () => {
  it('AC-52: folds the build gate and names the Windows job; AC-56: reads its test report when the log names no test', async () => {
    const gh = fakeGithub({
      jobs: [
        { id: 1, name: 'build', conclusion: 'failure', steps: [{ name: 'All build parts passed', conclusion: 'failure' }] },
        { id: 2, name: 'Runner unit tests (windows)', conclusion: 'failure', steps: [{ name: 'Run runner unit tests', conclusion: 'failure' }] },
        { id: 3, name: 'build · unit tests (1/3)', conclusion: 'success', steps: [] },
      ],
      logs: { 2: `##[error]Process completed with exit code 1.\n${CLEANUP}` },
      artifacts: [{ id: 50, name: 'unit-test-report-windows' }, { id: 51, name: 'unit-test-report-1' }],
      zips: { 50: zipOf('.test-report.log', '--- apps/runner/__tests__/unit/launcher.test.ts ---\n(fail) launcher > dispatches status [5003.21ms]\n') },
    });
    const record = await readRedChecks(gh, 'o/r', 'sha1', null, now);
    if (!record || record === 'unchanged') throw new Error('expected a record');
    expect(record.jobs.map(j => j.name)).toEqual(['Runner unit tests (windows)']);
    expect(record.jobs[0].lines).toContain('  x launcher > dispatches status');
    expect(record.jobs[0].lines).not.toContain('git version');
    expect(record.jobs[0].rule).toBe('test');
    expect(record.cause).toBe('failure');
    // The gate's own log is never read.
    expect(gh.calls.some(c => c.includes('/jobs/1/logs'))).toBe(false);
  });

  it('AC-51: a Postgres job whose database dropped its connections reads as a likely flake', async () => {
    const gh = fakeGithub({
      jobs: [{ id: 4, name: 'DB architecture (real Postgres)', conclusion: 'failure', steps: [{ name: 'Run DB architecture tests', conclusion: 'failure' }] }],
      logs: { 4: `${'[neon-sql-shim] idle client error: terminating connection due to administrator command\n'.repeat(30)}##[error]Process completed with exit code 1.\n${CLEANUP}` },
    });
    const record = await readRedChecks(gh, 'o/r', 'sha1', null, now);
    if (!record || record === 'unchanged') throw new Error('expected a record');
    expect(record.jobs[0].rule).toBe('db_connection_lost');
    expect(record.cause).toBe('flake');
  });

  it('a run already read at the same attempt costs one request and is unchanged', async () => {
    const gh = fakeGithub({ jobs: [], logs: {} });
    expect(await readRedChecks(gh, 'o/r', 'sha1', { runId: 7, runAttempt: 1 }, now)).toBe('unchanged');
    expect(gh.calls).toHaveLength(1);
  });

  it('no failed run is no record', async () => {
    const gh = fakeGithub({ jobs: [], logs: {} });
    gh.json = async () => ({ workflow_runs: [] });
    expect(await readRedChecks(gh, 'o/r', 'sha1', null, now)).toBeNull();
  });
});

describe('readRedChecks with the PR (R-3 not-this-PR rules)', () => {
  const WINDOWS_JOB = { id: 2, name: 'Runner unit tests (windows)', conclusion: 'failure', steps: [{ name: 'Run runner unit tests', conclusion: 'failure' }] };
  const FAILING = '(fail) launcher > dispatches status [5.00ms]\nerror: expect(received).toBe(expected)';

  /** One PR into dev, its files, and dev's runs of the same workflow. */
  function prGithub(opts: { files: string[]; baseJobs?: unknown[]; baseConclusion?: string; baseCreated?: string }): Gh & { calls: string[] } {
    const gh = fakeGithub({ jobs: [WINDOWS_JOB], logs: { 2: FAILING } });
    const json = gh.json.bind(gh);
    gh.json = async (path: string) => {
      if (path.includes('/actions/runs?branch=')) {
        gh.calls.push(path);
        return { workflow_runs: [
          { id: 90, workflow_id: 11, created_at: '2026-10-23T10:00:00Z', conclusion: 'failure' }, // after this run: not "at the same time"
          { id: 80, workflow_id: 12, created_at: '2026-10-23T08:00:00Z', conclusion: 'failure' }, // another workflow
          { id: 70, workflow_id: 11, created_at: opts.baseCreated ?? '2026-10-23T08:00:00Z', conclusion: opts.baseConclusion ?? 'failure' },
        ] };
      }
      if (path.includes('/actions/runs?')) { gh.calls.push(path); return { workflow_runs: [{ id: 7, run_attempt: 1, workflow_id: 11, created_at: '2026-10-23T08:30:00Z', updated_at: '2026-10-23T08:50:00Z' }] }; }
      if (path.endsWith('/runs/70/jobs')) { gh.calls.push(path); return { jobs: opts.baseJobs ?? [] }; }
      if (path.endsWith('/pulls/5')) { gh.calls.push(path); return { base: { ref: 'dev' } }; }
      if (path.includes('/pulls/5/files')) { gh.calls.push(path); return opts.files.map(filename => ({ filename })); }
      return json(path);
    };
    return gh;
  }

  it("a job red on the base branch at the same time is not this PR's code", async () => {
    const gh = prGithub({ files: ['apps/runner/src/a.ts'], baseJobs: [{ name: 'Runner unit tests (windows)', conclusion: 'failure' }] });
    const record = await readRedChecks(gh, 'o/r', 'sha1', null, now, { number: 5 });
    if (!record || record === 'unchanged') throw new Error('expected a record');
    expect(record.jobs[0].rule).toBe('red_on_base');
    expect(record.cause).toBe('flake');
    expect(gh.calls).toContain('/repos/o/r/actions/runs?branch=dev&status=completed&per_page=20');
    expect(gh.calls.some(c => c.endsWith('/runs/90/jobs'))).toBe(false);
  });

  it('a job green on the base branch keeps its failing test', async () => {
    const gh = prGithub({ files: ['apps/runner/src/a.ts'], baseConclusion: 'success' });
    const record = await readRedChecks(gh, 'o/r', 'sha1', null, now, { number: 5 });
    if (!record || record === 'unchanged') throw new Error('expected a record');
    expect(record.jobs[0].rule).toBe('test');
    expect(record.cause).toBe('failure');
  });

  it('the Windows runner job with no runner path in the diff is unrelated to it', async () => {
    const gh = prGithub({ files: ['apps/web/src/app/page.tsx'], baseConclusion: 'success' });
    const record = await readRedChecks(gh, 'o/r', 'sha1', null, now, { number: 5 });
    if (!record || record === 'unchanged') throw new Error('expected a record');
    expect(record.jobs[0].rule).toBe('unrelated_to_diff');
    expect(record.cause).toBe('flake');
  });

  it('without the PR, or when the logs already call it a flake, the PR is not read', async () => {
    const gh = prGithub({ files: ['apps/web/src/app/page.tsx'] });
    await readRedChecks(gh, 'o/r', 'sha1', null, now);
    expect(gh.calls.some(c => c.includes('/pulls/'))).toBe(false);
    const flaky = fakeGithub({ jobs: [WINDOWS_JOB], logs: { 2: 'Connection terminated unexpectedly' } });
    await readRedChecks(flaky, 'o/r', 'sha1', null, now, { number: 5 });
    expect(flaky.calls.some(c => c.includes('/pulls/'))).toBe(false);
  });

  it('a full page of files may be truncated, so it is not a diff', async () => {
    const gh = prGithub({ files: Array.from({ length: 100 }, (_, i) => `docs/${i}.md`) });
    expect(await changedPaths(gh, 'o/r', 5)).toBeNull();
  });
});

describe('needsJudgement', () => {
  const rec = (over: object) => ({ headSha: 'h', runId: 1, runAttempt: 1, at: 't', jobs: [{ name: 'e2e', step: null, lines: 'Error: boom', rule: 'none' as const }], cause: 'unknown' as const, signature: 's', ...over });
  it('asks only for an unknown cause with lines and no judgement of this failure', () => {
    expect(needsJudgement(rec({}))).toBe(true);
    expect(needsJudgement(rec({ cause: 'failure' }))).toBe(false);
    expect(needsJudgement(rec({ jobs: [{ name: 'e2e', step: null, lines: null, rule: 'none' }] }))).toBe(false);
    const judgement = { decision: 'code', confidence: null, source: 'fallback', model: null, reasonCode: 'fallback_low_confidence', policyVersion: 'p', signature: 's', at: 't' };
    expect(needsJudgement(rec({ judgement }))).toBe(false);
    expect(needsJudgement(rec({ judgement: { ...judgement, signature: 'old' } }))).toBe(true);
  });
});

describe('reportArtifactFor', () => {
  const artifacts = [{ id: 1, name: 'unit-test-report-windows' }, { id: 2, name: 'unit-test-report-2' }, { id: 3, name: 'unit-test-report-3', expired: true }];
  it('matches the Windows job and a shard by its number', () => {
    expect(reportArtifactFor('Runner unit tests (windows)', artifacts)).toBe(1);
    expect(reportArtifactFor('build · unit tests (2/3)', artifacts)).toBe(2);
  });
  it('skips expired artifacts and jobs that upload none', () => {
    expect(reportArtifactFor('build · unit tests (3/3)', artifacts)).toBeNull();
    expect(reportArtifactFor('DB architecture (real Postgres)', artifacts)).toBeNull();
  });
});

describe('unzipFirstText', () => {
  it('reads the one file of an artifact zip', () => {
    expect(unzipFirstText(zipOf('.test-report.log', 'hello report'))).toBe('hello report');
  });
  it('is null for bytes that are not a zip', () => {
    expect(unzipFirstText(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
