import { describe, it, expect } from 'bun:test';
import {
  failingLines, testReportFailures, firstTestName, foldSummaryGates, isSummaryGate,
  classifyJob, causeOf, signatureOf, mergeRedRecord, redCheckView, parseRedRecord, ciFixHistory,
  type RedCheckRecord, type RedJob,
} from './red-check-cause';

/**
 * Home said "Tests are failing." with Start fix on two PRs that were not code
 * defects (surface-ia §11). These fixtures are those two shapes: a real-Postgres
 * job whose database dropped its connections, and a `build` summary gate red
 * only because the Windows runner job failed, whose log ends in cleanup.
 */

const CLEANUP = [
  '2026-10-23T09:12:01.0000000Z Post job cleanup.',
  '2026-10-23T09:12:01.1000000Z [command]"C:\\Program Files\\Git\\bin\\git.exe" version',
  '2026-10-23T09:12:01.2000000Z git version 2.47.1.windows.1',
  '2026-10-23T09:12:01.3000000Z Temporarily overriding HOME before making global git config changes',
  '2026-10-23T09:12:01.4000000Z [command]"C:\\Program Files\\Git\\bin\\git.exe" config --local --name-only --get-regexp core\\.sshCommand',
  '2026-10-23T09:12:01.5000000Z Cleaning up orphan processes',
].join('\n');

const POSTGRES_LOG = [
  '2026-10-23T09:00:00.0000000Z ##[group]Run bun run test:db-architecture',
  ...Array.from({ length: 40 }, () => '2026-10-23T09:00:01.0000000Z [neon-sql-shim] idle client error: terminating connection due to administrator command'),
  '2026-10-23T09:00:02.0000000Z ##[error]Process completed with exit code 1.',
  CLEANUP,
].join('\n');

const WINDOWS_LOG = [
  '2026-10-23T09:00:00.0000000Z ##[group]Run runner unit tests',
  '2026-10-23T09:00:01.0000000Z (pass) launcher > parses argv [0.12ms]',
  '2026-10-23T09:00:02.0000000Z (fail) launcher > dispatches status on Windows [5003.21ms]',
  '2026-10-23T09:00:02.1000000Z error: expect(received).toBe(expected)',
  '2026-10-23T09:00:03.0000000Z (pass) launcher > prints help [0.40ms]',
  '2026-10-23T09:00:04.0000000Z ##[error]Process completed with exit code 1.',
  CLEANUP,
].join('\n');

const job = (over: Partial<RedJob>): RedJob => ({ name: 'job', step: null, lines: null, rule: 'none', ...over });
const record = (over: Partial<RedCheckRecord>): RedCheckRecord => ({
  headSha: 'abc', runId: 1, runAttempt: 1, at: '2026-10-23T09:00:00Z', jobs: [], cause: 'unknown', signature: '', ...over,
});

describe('failingLines (R-2, AC-53)', () => {
  it('returns the failing test lines from mid-log, none of the cleanup tail', () => {
    const lines = failingLines(WINDOWS_LOG)!;
    expect(lines).toContain('(fail) launcher > dispatches status on Windows');
    expect(lines).toContain('error: expect(received).toBe(expected)');
    expect(lines).not.toContain('Post job cleanup');
    expect(lines).not.toContain('git version');
    expect(lines).not.toContain('Process completed with exit code');
  });

  it('dedupes a repeated environment error to one line', () => {
    const lines = failingLines(POSTGRES_LOG)!;
    expect(lines.split('\n')).toEqual(['[neon-sql-shim] idle client error: terminating connection due to administrator command']);
  });

  it('prefers the runner digest when the log carries one', () => {
    const log = ['(fail) a > b', '', '1 of 9 unit test files failed:', '', 'apps/x.test.ts', '  x a > b', '', 'Full output: .test-report.log', CLEANUP].join('\n');
    expect(failingLines(log)).toBe('1 of 9 unit test files failed:\napps/x.test.ts\n  x a > b');
  });

  it('falls back to the end of the job steps, never the cleanup, when nothing names a failure', () => {
    const log = ['step one', 'step two', CLEANUP].join('\n');
    expect(failingLines(log)).toBe('step one\nstep two');
  });

  it('is null for an empty log', () => {
    expect(failingLines('')).toBeNull();
    expect(failingLines(null)).toBeNull();
  });
});

describe('testReportFailures (R-2, AC-56)', () => {
  it('names the failing file and tests from a .test-report.log', () => {
    const report = 'INCOMPLETE RUN (SIGTERM)\n\n--- apps/runner/__tests__/unit/launcher.test.ts ---\n(pass) a [1ms]\n(fail) launcher > dispatches status [5003.21ms]\n';
    const out = testReportFailures(report)!;
    expect(out).toContain('apps/runner/__tests__/unit/launcher.test.ts');
    expect(out).toContain('  x launcher > dispatches status');
    expect(firstTestName(out)).toBe('launcher > dispatches status');
  });
});

describe('foldSummaryGates (R-1, AC-52)', () => {
  const gate = { name: 'build', step: 'All build parts passed' };
  const windows = { name: 'Runner unit tests (windows)', step: 'Run runner unit tests' };

  it('folds the build gate into the job it reports on', () => {
    expect(isSummaryGate(gate)).toBe(true);
    expect(foldSummaryGates([gate, windows]).map(j => j.name)).toEqual(['Runner unit tests (windows)']);
  });

  it('names the gate when it is the only failed job', () => {
    expect(foldSummaryGates([gate]).map(j => j.name)).toEqual(['build']);
  });
});

describe('classifyJob and causeOf (R-3)', () => {
  it('a database connection the server terminated is a likely flake', () => {
    expect(classifyJob(POSTGRES_LOG, failingLines(POSTGRES_LOG))).toBe('db_connection_lost');
  });

  it('a failing test is a real failure', () => {
    expect(classifyJob(WINDOWS_LOG, failingLines(WINDOWS_LOG))).toBe('test');
  });

  it('a timeout with no failing assertion is a likely flake; with one it is a failure', () => {
    const timeout = "##[error]The action 'Run runner unit tests' has timed out after 20 minutes.";
    expect(classifyJob(timeout, failingLines(timeout))).toBe('timeout_no_assertion');
    const both = `(fail) a > b\n${timeout}`;
    expect(classifyJob(both, failingLines(both))).toBe('test');
  });

  it('a lost runner is a likely flake', () => {
    expect(classifyJob('The runner has received a shutdown signal.', null)).toBe('runner_lost');
  });

  it('flake only when every job is; any real failure wins', () => {
    expect(causeOf([job({ rule: 'db_connection_lost' })])).toBe('flake');
    expect(causeOf([job({ rule: 'db_connection_lost' }), job({ rule: 'test' })])).toBe('failure');
    expect(causeOf([job({ rule: 'none' })])).toBe('unknown');
  });
});

describe('redCheckView (R-4, R-5, AC-51, AC-52)', () => {
  it('Postgres case: names the job and cause, says the fixes did not help, leads with Re-run', () => {
    const jobs = [job({ name: 'DB architecture (real Postgres)', rule: 'db_connection_lost' })];
    const view = redCheckView(record({ jobs, cause: causeOf(jobs) }), { pushedNothing: 0, noChange: 2 });
    expect(view.checks).toEqual(['DB architecture (real Postgres)']);
    expect(view.sentence).toBe('DB architecture (real Postgres) failed: the Postgres tests lost their database connection, which looks like a flake, not the code. 2 automatic fixes did not change the result.');
    expect(view.primary).toBe('rerun');
  });

  it('Windows case: names the runner job and its test, never build, and leads with Start fix', () => {
    const lines = failingLines(WINDOWS_LOG);
    const jobs = [job({ name: 'Runner unit tests (windows)', step: 'Run runner unit tests', lines, rule: 'test' })];
    const view = redCheckView(record({ jobs, cause: causeOf(jobs) }), { pushedNothing: 1, noChange: 0 });
    expect(view.checks).toEqual(['Runner unit tests (windows)']);
    expect(view.sentence).toBe('Runner unit tests (windows) failed: launcher > dispatches status on Windows. 1 automatic fix pushed nothing.');
    expect(view.sentence).not.toContain('build');
    expect(view.primary).toBe('fix');
  });

  it('never reads "Tests are failing." alone', () => {
    expect(redCheckView(record({ jobs: [job({ name: 'lint', step: 'Run lint' })] })).sentence).toBe('lint failed at "Run lint".');
  });
});

describe('mergeRedRecord (R-4, AC-54)', () => {
  const flakeJobs = [job({ name: 'DB architecture (real Postgres)', rule: 'db_connection_lost' })];
  const sig = signatureOf(flakeJobs);
  const before = record({ jobs: flakeJobs, cause: 'flake', signature: sig, runAttempt: 1, reruns: [{ at: 't', by: 'u', runId: 1, signature: sig }] });

  it('the same head failing again after a re-run with the same signature promotes Start fix', () => {
    const merged = mergeRedRecord(before, record({ jobs: flakeJobs, cause: 'flake', signature: sig, runAttempt: 2 }));
    expect(merged.failedAfterRerun).toBe(true);
    expect(merged.reruns).toHaveLength(1);
    const view = redCheckView(merged);
    expect(view.primary).toBe('fix');
    expect(view.sentence).toBe('DB architecture (real Postgres) failed twice, before and after a re-run: the Postgres tests lost their database connection. So it is probably not a flake.');
  });

  it('a different failure after the re-run is not "failed twice"', () => {
    const other = [job({ name: 'DB architecture (real Postgres)', rule: 'runner_lost' })];
    const merged = mergeRedRecord(before, record({ jobs: other, cause: 'flake', signature: signatureOf(other), runAttempt: 2 }));
    expect(merged.failedAfterRerun).toBe(false);
    expect(redCheckView(merged).primary).toBe('rerun');
  });

  it('the same reading again (no new attempt) changes nothing', () => {
    const merged = mergeRedRecord(before, record({ jobs: flakeJobs, cause: 'flake', signature: sig, runAttempt: 1 }));
    expect(merged.failedAfterRerun).toBe(false);
  });

  it('a new head starts clean', () => {
    const merged = mergeRedRecord({ ...before, failedAfterRerun: true }, record({ headSha: 'def', jobs: flakeJobs, cause: 'flake', signature: sig }));
    expect(merged.failedAfterRerun).toBeUndefined();
    expect(merged.reruns).toBeUndefined();
  });
});

describe('parseRedRecord', () => {
  it('accepts a stored record and rejects anything else', () => {
    expect(parseRedRecord(record({}))?.headSha).toBe('abc');
    expect(parseRedRecord({ headSha: 'x' })).toBeNull();
    expect(parseRedRecord(null)).toBeNull();
  });
});

describe('ciFixHistory (R-3)', () => {
  it('a fix filed for the current head pushed nothing; one for an earlier head did not change the result', () => {
    expect(ciFixHistory(['h3', 'h1', 'h2', null], 'h3')).toEqual({ pushedNothing: 1, noChange: 2 });
    expect(ciFixHistory([], 'h3')).toEqual({ pushedNothing: 0, noChange: 0 });
  });
});
