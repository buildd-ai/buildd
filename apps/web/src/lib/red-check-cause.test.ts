import { describe, it, expect } from 'bun:test';
import {
  failingLines, testReportFailures, firstTestName, foldSummaryGates, isSummaryGate,
  classifyJob, causeOf, signatureOf, mergeRedRecord, redCheckView, parseRedRecord, ciFixHistory,
  applyNotThisPr, unrelatedToDiff, effectiveCause, detectRerunnableFailure,
  type RedCheckRecord, type RedJob, type RedJudgement,
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

describe("not this PR's code (R-3 rules)", () => {
  const windows = job({ name: 'Runner unit tests (windows)', lines: '(fail) launcher > dispatches status', rule: 'test' });

  it('a scoped job is unrelated when the diff touches none of its paths', () => {
    expect(unrelatedToDiff('Runner unit tests (windows)', ['apps/web/src/app/page.tsx', 'docs/x.md'])).toBe(true);
    expect(unrelatedToDiff('Runner unit tests (windows)', ['apps/runner/src/workers.ts'])).toBe(false);
    expect(unrelatedToDiff('Runner unit tests (windows)', ['packages/core/db/schema.ts'])).toBe(false);
  });

  it('never decides without a readable diff, or for a job with no declared scope', () => {
    expect(unrelatedToDiff('Runner unit tests (windows)', null)).toBe(false);
    expect(unrelatedToDiff('Runner unit tests (windows)', [])).toBe(false);
    expect(unrelatedToDiff('build · unit tests (1/3)', ['docs/x.md'])).toBe(false);
  });

  it("a failing test in a job unrelated to the diff is not this PR's code", () => {
    const jobs = applyNotThisPr([windows], { changed: ['apps/web/src/app/page.tsx'] });
    expect(jobs[0].rule).toBe('unrelated_to_diff');
    expect(jobs[0].lines).toBe(windows.lines);
    expect(causeOf(jobs)).toBe('flake');
  });

  it('the same job red on the base branch wins over its failing test', () => {
    const jobs = applyNotThisPr([windows], { redOnBase: new Set(['Runner unit tests (windows)']), changed: ['apps/runner/a.ts'] });
    expect(jobs[0].rule).toBe('red_on_base');
    expect(causeOf(jobs)).toBe('flake');
  });

  it('a job green on the base branch keeps its own rule', () => {
    const jobs = applyNotThisPr([windows], { redOnBase: new Set(['lint']), changed: ['apps/runner/a.ts'] });
    expect(jobs[0].rule).toBe('test');
    expect(causeOf(jobs)).toBe('failure');
  });

  it('the card says why, and does not call it a flake', () => {
    const base = redCheckView(record({ jobs: [{ ...windows, rule: 'red_on_base' }], cause: 'flake' }));
    expect(base.sentence).toBe("Runner unit tests (windows) is failing on the base branch too, so it is not this PR's code.");
    expect(base.primary).toBe('rerun');
    const unrelated = redCheckView(record({ jobs: [{ ...windows, rule: 'unrelated_to_diff' }], cause: 'flake' }));
    expect(unrelated.sentence).toBe('Runner unit tests (windows) failed, but this PR changes nothing it tests.');
  });
});

describe("the decision model's judgement (R-3 fallback)", () => {
  const jobs = [job({ name: 'e2e', step: 'Run e2e', lines: 'Error: page.goto: net::ERR_CONNECTION_RESET' })];
  const sig = signatureOf(jobs);
  const judged = (decision: RedJudgement['decision'], signature = sig): RedJudgement => ({
    decision, confidence: 0.9, source: 'model', model: 'jev', reasonCode: `cause_${decision}`, policyVersion: 'p', signature, at: 't',
  });

  it('an environment judgement of an unknown cause reads as a flake and leads with Re-run', () => {
    const r = record({ jobs, cause: 'unknown', signature: sig, judgement: judged('environment') });
    expect(effectiveCause(r)).toBe('flake');
    const view = redCheckView(r);
    expect(view.cause).toBe('flake');
    expect(view.primary).toBe('rerun');
    expect(view.sentence).toBe('e2e failed at "Run e2e", which looks like a flake, not the code.');
  });

  it('a code judgement leads with Start fix', () => {
    const r = record({ jobs, cause: 'unknown', signature: sig, judgement: judged('code') });
    expect(effectiveCause(r)).toBe('failure');
    expect(redCheckView(r).primary).toBe('fix');
  });

  it('never overrides a rule, and never answers for a different failure', () => {
    expect(effectiveCause(record({ jobs, cause: 'failure', signature: sig, judgement: judged('environment') }))).toBe('failure');
    expect(effectiveCause(record({ jobs, cause: 'unknown', signature: sig, judgement: judged('environment', 'other') }))).toBe('unknown');
  });

  it('is kept across readings of the same failure and dropped for a new one', () => {
    const prev = record({ jobs, cause: 'unknown', signature: sig, judgement: judged('environment') });
    expect(mergeRedRecord(prev, record({ jobs, cause: 'unknown', signature: sig, runAttempt: 2 })).judgement?.decision).toBe('environment');
    expect(mergeRedRecord(prev, record({ jobs, cause: 'unknown', signature: 'new', runAttempt: 2 })).judgement).toBeUndefined();
  });
});

describe('detectRerunnableFailure', () => {
  it('names a lost database connection and the infra signatures, never a test failure', () => {
    expect(detectRerunnableFailure('FATAL: terminating connection due to administrator command')).toBe('db_connection_lost');
    expect(detectRerunnableFailure('toomanyrequests: You have reached your pull rate limit')).toBe('registry_rate_limit');
    expect(detectRerunnableFailure('(fail) a > b')).toBeNull();
    expect(detectRerunnableFailure(null)).toBeNull();
  });

  /**
   * A real DB-architecture failure (two tests failing on the PR's own change):
   * the shim prints the termination line for every pooled client when the job
   * stops Postgres, after the summary. Read as infra, it was re-run three
   * times and never got a fix.
   */
  const SHIM = '[neon-sql-shim] idle client error: terminating connection due to administrator command';
  const DB_ARCH_TEST_FAILURE = [
    '2026-10-24T16:02:00.0000000Z ##[group]Run bun run test:db',
    '2026-10-24T16:02:10.0000000Z tests/db/escalation-decisions.test.ts:',
    '2026-10-24T16:02:10.1000000Z (pass) escalation decisions > files a question [12.00ms]',
    '2026-10-24T16:02:10.2000000Z error: expect(received).toBe(expected)',
    '2026-10-24T16:02:10.3000000Z Expected: "success"',
    '2026-10-24T16:02:10.4000000Z Received: "pending"',
    '2026-10-24T16:02:10.5000000Z       at <anonymous> (tests/db/escalation-decisions.test.ts:165:7)',
    '2026-10-24T16:02:10.6000000Z (fail) escalation decisions > an approved PR reads success [30.00ms]',
    '2026-10-24T16:02:20.0000000Z tests/db/workflow-open-pr-status.test.ts:',
    '2026-10-24T16:02:20.1000000Z (fail) open PR status > approved and green [25.00ms]',
    '2026-10-24T16:14:30.0000000Z [test:db] 2/188 file(s) failed:',
    '2026-10-24T16:14:30.1000000Z   apps/web/tests/db/escalation-decisions.test.ts',
    '2026-10-24T16:14:30.2000000Z   apps/web/tests/db/workflow-open-pr-status.test.ts',
    `2026-10-24T16:14:31.0000000Z ${SHIM}`,
    `2026-10-24T16:14:31.1000000Z ${SHIM}`,
    `2026-10-24T16:14:31.2000000Z ${SHIM}`,
    '2026-10-24T16:14:32.0000000Z ##[error]Process completed with exit code 1.',
    CLEANUP,
  ].join('\n');

  it('never reads a DB-architecture run with failing tests as infra, whatever the shim prints at teardown', () => {
    expect(detectRerunnableFailure(DB_ARCH_TEST_FAILURE)).toBeNull();
    expect(classifyJob(DB_ARCH_TEST_FAILURE, failingLines(DB_ARCH_TEST_FAILURE))).toBe('test');
  });

  it('ignores termination lines after the summary even when no test is named', () => {
    const teardownOnly = [
      '2026-10-24T16:14:30.0000000Z [test:db] 1/188 file(s) failed:',
      '2026-10-24T16:14:30.1000000Z   apps/web/tests/db/a.test.ts',
      `2026-10-24T16:14:31.0000000Z ${SHIM}`,
    ].join('\n');
    expect(detectRerunnableFailure(teardownOnly)).toBeNull();
  });

  it('names a connection terminated mid-run, before the summary, with no failing test', () => {
    const midRun = [
      '2026-10-24T16:02:00.0000000Z ##[group]Run bun run test:db',
      '2026-10-24T16:02:10.0000000Z tests/db/escalation-decisions.test.ts:',
      '2026-10-24T16:02:10.1000000Z error: terminating connection due to administrator command',
      '2026-10-24T16:02:10.2000000Z [test:db] 1/188 file(s) failed:',
      '2026-10-24T16:02:10.3000000Z   apps/web/tests/db/escalation-decisions.test.ts',
      `2026-10-24T16:02:11.0000000Z ${SHIM}`,
      CLEANUP,
    ].join('\n');
    expect(detectRerunnableFailure(midRun)).toBe('db_connection_lost');
    expect(classifyJob(midRun, failingLines(midRun))).toBe('db_connection_lost');
  });

  it('names a test failed by the termination, but not when another test failed on its own', () => {
    const dropped = [
      '2026-10-24T16:02:10.0000000Z (pass) store > reads [3.00ms]',
      '2026-10-24T16:02:10.1000000Z error: terminating connection due to administrator command',
      '2026-10-24T16:02:10.2000000Z (fail) store > writes [12.00ms]',
    ];
    const ownFailure = [
      '2026-10-24T16:02:11.0000000Z error: expect(received).toBe(expected)',
      '2026-10-24T16:02:11.1000000Z (fail) store > counts [4.00ms]',
    ];
    expect(detectRerunnableFailure(dropped.join('\n'))).toBe('db_connection_lost');
    expect(detectRerunnableFailure([...dropped, ...ownFailure].join('\n'))).toBeNull();
    expect(detectRerunnableFailure([...ownFailure, ...dropped].join('\n'))).toBeNull();
  });
});
