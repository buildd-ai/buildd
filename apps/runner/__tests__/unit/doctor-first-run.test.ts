/**
 * Doctor checks for fresh/never-started runner.
 *
 * On a fresh install that has never been started, doctor should show info
 * messages ("not started yet") instead of errors/warnings for the three
 * runner-facing checks (process, log, history-db).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/doctor-first-run.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    const report = runDiagnostics();

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
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Create history.db to mark as having run once
    const dbPath = join(home, 'history.db');
    writeFileSync(dbPath, Buffer.from([0x53, 0x51, 0x4c, 0x69])); // SQLite magic bytes

    const report = runDiagnostics();

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
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Create log file to mark as having run once
    mkdirSync(home, { recursive: true });
    writeFileSync(logPath, 'some runner output\n');

    const report = runDiagnostics();

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

  test('socket probe path: never-started dir gives no errors with runnerProcessFromProbe', () => {
    // Set up isolated home
    const home = mkdtempSync(join(root, 'test-probe-fresh-'));
    const logPath = join(home, 'temp-log');
    const socketPath = join(home, 'runner.sock');
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Mock probe for a dead socket (no runner process)
    const deadProbe = { state: 'dead', pid: null };
    const runnerProcessCheck = runnerProcessFromProbe(deadProbe, socketPath, isRunnerNeverStarted());

    // Create report with the probe-based check
    const report = runDiagnostics({ runnerProcess: runnerProcessCheck });

    const runnerProcess = report.checks.find((c) => c.name === 'runner-process');
    const runnerLog = report.checks.find((c) => c.name === 'runner-log');
    const historyDb = report.checks.find((c) => c.name === 'history-db');

    // With socket probe on never-started dir, these three should be ok
    expect(runnerProcess!.status).toBe('ok');
    expect(runnerProcess!.message).toContain('not started yet');

    expect(runnerLog!.status).toBe('ok');
    expect(runnerLog!.message).toContain('not started yet');

    expect(historyDb!.status).toBe('ok');
    expect(historyDb!.message).toContain('created on first run');

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });

  test('socket probe path: with history.db and dead socket gives runner-process error', () => {
    // Set up isolated home
    const home = mkdtempSync(join(root, 'test-probe-db-'));
    const logPath = join(home, 'temp-log');
    const socketPath = join(home, 'runner.sock');
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Create history.db to mark as having run once
    const dbPath = join(home, 'history.db');
    writeFileSync(dbPath, Buffer.from([0x53, 0x51, 0x4c, 0x69])); // SQLite magic bytes

    // Mock probe for a dead socket
    const deadProbe = { state: 'dead', pid: null };
    const runnerProcessCheck = runnerProcessFromProbe(deadProbe, socketPath, isRunnerNeverStarted());

    const report = runDiagnostics({ runnerProcess: runnerProcessCheck });

    const runnerProcess = report.checks.find((c) => c.name === 'runner-process');

    // With db present, a dead socket is a real error (runner ran before but is not running now)
    expect(runnerProcess!.status).toBe('error');
    expect(runnerProcess!.message).toContain('No runner answers');

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });

  test('service install with no log suggests buildd service logs', () => {
    // Set up isolated home
    const home = mkdtempSync(join(root, 'test-service-'));
    const logPath = join(home, 'temp-log');
    process.env.BUILDD_HOME = home;
    process.env.BUILDD_RUNNER_LOG_PATH = logPath;

    // Create history.db to mark runner has run before (so not a first-run case)
    const dbPath = join(home, 'history.db');
    writeFileSync(dbPath, Buffer.from([0x53, 0x51, 0x4c, 0x69])); // SQLite magic bytes

    // Test will verify that when buildd service status succeeds, the message points to service logs
    // We test the runnerLog check which calls execSync internally
    const report = runDiagnostics();

    const runnerLog = report.checks.find((c) => c.name === 'runner-log');

    // When buildd service status is available and shows active, message should point to service logs
    // Otherwise it says "not created yet"
    expect(runnerLog!.status).toBe('warn');
    const msg = runnerLog!.message;
    const pointsToServiceLogs = msg.includes('buildd service logs');
    const saysNotCreatedYet = msg.includes('not created yet');
    expect(pointsToServiceLogs || saysNotCreatedYet).toBe(true);

    // Clean up
    rmSync(home, { recursive: true, force: true });
  });
});
