import { describe, it, expect, mock } from 'bun:test';
import { deflateRawSync } from 'zlib';

// No database or GitHub here: readRedChecks takes its GitHub reads injected.
mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@/lib/github', () => ({ githubApi: async () => null, githubApiText: async () => '', getInstallationToken: async () => 't' }));

const { readRedChecks, reportArtifactFor, unzipFirstText } = await import('./red-check-record');
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
