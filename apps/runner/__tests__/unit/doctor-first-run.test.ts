/**
 * Doctor checks for fresh/never-started runner.
 *
 * On a fresh install that has never been started, doctor should show info
 * messages ("not started yet") instead of errors/warnings for the three
 * runner-facing checks (process, log, history-db).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/doctor-first-run.test.ts
 */
import { describe, test, expect, afterAll, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const injectedHome = process.env.BUILDD_HOME;
const injectedLogPath = process.env.BUILDD_RUNNER_LOG_PATH;

// Root for all tests
const root = mkdtempSync(join(tmpdir(), 'buildd-doctor-fresh-'));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runDiagnostics, isRunnerNeverStarted } = require('../../src/doctor');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runnerProcessFromProbe } = require('../../src/runner-socket');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execSync } = require('child_process');

afterAll(() => {
  if (injectedHome === undefined) delete process.env.BUILDD_HOME;
  else process.env.BUILDD_HOME = injectedHome;
  if (injectedLogPath === undefined) delete process.env.BUILDD_RUNNER_LOG_PATH;
  else process.env.BUILDD_RUNNER_LOG_PATH = injectedLogPath;
  rmSync(root, { recursive: true, force: true });
});

describe('First-run checks (never-started runner)', () => {
  test('a fresh directory with no history.db, no log, no socket shows ok for all three', () => {
    // Set up isolated home
    const home = mkdtempSync(join(root, 'test-fresh-'));
    const logPath = join(home, 'temp-log');
    const socketPath = join(home, 'runner.sock');
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Inject probe for absent socket on a fresh directory
    const absenceProbe = { state: 'absent' as const };
    const runnerProcessCheck = runnerProcessFromProbe(absenceProbe, socketPath, isRunnerNeverStarted());
    const report = runDiagnostics({ runnerProcess: runnerProcessCheck });

    const runnerProcess = report.checks.find((c) => c.name === 'runner-process');
    const runnerLog = report.checks.find((c) => c.name === 'runner-log');
    const historyDb = report.checks.find((c) => c.name === 'history-db');

    expect(runnerProcess).toBeTruthy();
    expect(runnerLog).toBeTruthy();
    expect(historyDb).toBeTruthy();

    // All three should be 'ok' with "not started" messaging
    expect(runnerProcess!.status).toBe('ok');
    expect(runnerProcess!.message).toContain('not started yet');

    expect(runnerLog!.status).toBe('ok');
    expect(runnerLog!.message).toContain('not started yet');

    expect(historyDb!.status).toBe('ok');
    expect(historyDb!.message).toContain('created on first run');

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });

  test('with history.db present but no socket, runner-process is an error', () => {
    // Set up isolated home
    const home = mkdtempSync(join(root, 'test-db-'));
    const logPath = join(home, 'temp-log');
    const socketPath = join(home, 'runner.sock');
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Create history.db to mark as having run once
    const dbPath = join(home, 'history.db');
    writeFileSync(dbPath, Buffer.from([0x53, 0x51, 0x4c, 0x69])); // SQLite magic bytes

    // Inject probe for absent socket (no socket file exists)
    const absenceProbe = { state: 'absent' as const };
    const runnerProcessCheck = runnerProcessFromProbe(absenceProbe, socketPath, isRunnerNeverStarted());
    const report = runDiagnostics({ runnerProcess: runnerProcessCheck });

    const runnerProcess = report.checks.find((c) => c.name === 'runner-process');
    const runnerLog = report.checks.find((c) => c.name === 'runner-log');
    const historyDb = report.checks.find((c) => c.name === 'history-db');

    // Once db exists, the runner is considered to have run before
    // So a missing process is now a real error
    expect(runnerProcess!.status).toBe('error');
    expect(runnerProcess!.message).not.toContain('not started yet');

    // Missing log when runner has run before is a warning
    expect(runnerLog!.status).toBe('warn');

    // History db exists and is ok
    expect(historyDb!.status).toBe('ok');

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });

  test('with log file present but no db, runner-process is error and log is ok', () => {
    // Set up isolated home
    const home = mkdtempSync(join(root, 'test-log-'));
    const logPath = join(home, 'temp-log');
    const socketPath = join(home, 'runner.sock');
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Create log file to mark as having run once
    mkdirSync(home, { recursive: true });
    writeFileSync(logPath, 'some runner output\n');

    // Inject probe for absent socket (no socket file exists)
    const absenceProbe = { state: 'absent' as const };
    const runnerProcessCheck = runnerProcessFromProbe(absenceProbe, socketPath, isRunnerNeverStarted());
    const report = runDiagnostics({ runnerProcess: runnerProcessCheck });

    const runnerProcess = report.checks.find((c) => c.name === 'runner-process');
    const runnerLog = report.checks.find((c) => c.name === 'runner-log');
    const historyDb = report.checks.find((c) => c.name === 'history-db');

    // With log present, runner is considered to have run before
    // So missing process is a real error
    expect(runnerProcess!.status).toBe('error');

    // Log exists so it's ok
    expect(runnerLog!.status).toBe('ok');

    // History db doesn't exist, should be ok with "created on first run" message
    expect(historyDb!.status).toBe('ok');
    expect(historyDb!.message).toContain('created on first run');

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });

  test('socket probe path: never-started dir with absent socket shows ok', () => {
    // Set up isolated home
    const home = mkdtempSync(join(root, 'test-probe-fresh-'));
    const logPath = join(home, 'temp-log');
    const socketPath = join(home, 'runner.sock');
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Probe for absent socket (no runner process, no socket file)
    const absenceProbe = { state: 'absent' as const };
    const runnerProcessCheck = runnerProcessFromProbe(absenceProbe, socketPath, isRunnerNeverStarted());

    // Create report with the probe-based check
    const report = runDiagnostics({ runnerProcess: runnerProcessCheck });

    const runnerProcess = report.checks.find((c) => c.name === 'runner-process');
    const runnerLog = report.checks.find((c) => c.name === 'runner-log');
    const historyDb = report.checks.find((c) => c.name === 'history-db');

    // With absent socket on never-started dir, these three should be ok
    expect(runnerProcess!.status).toBe('ok');
    expect(runnerProcess!.message).toContain('not started yet');

    expect(runnerLog!.status).toBe('ok');
    expect(runnerLog!.message).toContain('not started yet');

    expect(historyDb!.status).toBe('ok');
    expect(historyDb!.message).toContain('created on first run');

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });

  test('socket probe path: with history.db and absent socket gives error', () => {
    // Set up isolated home
    const home = mkdtempSync(join(root, 'test-probe-db-'));
    const logPath = join(home, 'temp-log');
    const socketPath = join(home, 'runner.sock');
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Create history.db to mark as having run once
    const dbPath = join(home, 'history.db');
    writeFileSync(dbPath, Buffer.from([0x53, 0x51, 0x4c, 0x69])); // SQLite magic bytes

    // Probe for absent socket (no socket file)
    const absenceProbe = { state: 'absent' as const };
    const runnerProcessCheck = runnerProcessFromProbe(absenceProbe, socketPath, isRunnerNeverStarted());

    const report = runDiagnostics({ runnerProcess: runnerProcessCheck });

    const runnerProcess = report.checks.find((c) => c.name === 'runner-process');

    // With db present, absent socket is a real error (runner ran before but is not running now)
    expect(runnerProcess!.status).toBe('error');
    expect(runnerProcess!.message).toContain('No runner answers');

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });

  test('socket probe path: stale socket (no runner answers) is error even on fresh install', () => {
    // Set up isolated home
    const home = mkdtempSync(join(root, 'test-probe-stale-'));
    const logPath = join(home, 'temp-log');
    const socketPath = join(home, 'runner.sock');
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Probe for stale socket (socket file exists but doesn't answer)
    // This is true even on a fresh install with no db/log — socket file counts as evidence runner ran
    const staleProbe = { state: 'stale' as const };
    const runnerProcessCheck = runnerProcessFromProbe(staleProbe, socketPath, isRunnerNeverStarted());

    const report = runDiagnostics({ runnerProcess: runnerProcessCheck });

    const runnerProcess = report.checks.find((c) => c.name === 'runner-process');

    // Stale socket is an error, even on fresh install (socket file counts as evidence)
    expect(runnerProcess!.status).toBe('error');
    expect(runnerProcess!.message).toContain('No runner answers');

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });

  test('service install with no log points to buildd service logs', () => {
    // Set up isolated home
    const home = mkdtempSync(join(root, 'test-service-'));
    const logPath = join(home, 'temp-log');
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Create history.db to mark runner has run before
    const dbPath = join(home, 'history.db');
    writeFileSync(dbPath, Buffer.from([0x53, 0x51, 0x4c, 0x69])); // SQLite magic bytes

    // Inject hasService=true to simulate service install
    const report = runDiagnostics({ hasService: true });

    const runnerLog = report.checks.find((c) => c.name === 'runner-log');

    // When service is available, message should point to service logs
    expect(runnerLog!.status).toBe('warn');
    expect(runnerLog!.message).toContain('buildd service logs');

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });

  test('no service install with missing log says not created yet', () => {
    // Set up isolated home
    const home = mkdtempSync(join(root, 'test-nonservice-'));
    const logPath = join(home, 'temp-log');
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Create history.db to mark runner has run before
    const dbPath = join(home, 'history.db');
    writeFileSync(dbPath, Buffer.from([0x53, 0x51, 0x4c, 0x69])); // SQLite magic bytes

    // Inject hasService=false to simulate no service
    const report = runDiagnostics({ hasService: false });

    const runnerLog = report.checks.find((c) => c.name === 'runner-log');

    // No service, so should say "not created yet"
    expect(runnerLog!.status).toBe('warn');
    expect(runnerLog!.message).toContain('not created yet');

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });

  test('first-run ok lines are not fixable', () => {
    // Set up isolated home
    const home = mkdtempSync(join(root, 'test-firstrun-ok-'));
    const logPath = join(home, 'temp-log');
    const socketPath = join(home, 'runner.sock');
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Never-started directory: no db, log, or socket
    const absenceProbe = { state: 'absent' as const };
    const runnerProcessCheck = runnerProcessFromProbe(absenceProbe, socketPath, isRunnerNeverStarted());
    const report = runDiagnostics({ runnerProcess: runnerProcessCheck });

    const runnerProcess = report.checks.find((c) => c.name === 'runner-process');
    const runnerLog = report.checks.find((c) => c.name === 'runner-log');
    const historyDb = report.checks.find((c) => c.name === 'history-db');

    // All three "not started yet" / "created on first run" lines should be ok and NOT fixable
    expect(runnerProcess!.status).toBe('ok');
    expect(runnerProcess!.fixable).not.toBe(true);

    expect(runnerLog!.status).toBe('ok');
    expect(runnerLog!.fixable).not.toBe(true);

    expect(historyDb!.status).toBe('ok');
    expect(historyDb!.fixable).not.toBe(true);

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });
});
