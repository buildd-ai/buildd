/**
 * Regression guard: `cleanupOldLogs()` deletes any `.log` file in LOGS_DIR
 * whose mtime is older than 48h. `claims.log` is appended to constantly, so
 * in the common case its mtime never goes stale — but on an idle runner (no
 * claim attempts for 48h+) it would be wiped by this same sweep, destroying
 * months of the best forensic data available. `claims.log` must be exempt
 * by name, the same way doctor.ts's disk-usage cleanup already exempts it.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/session-logger-cleanup.test.ts
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Kept so the hook below can put it back. `runTestFile` injects a throwaway
// BUILDD_HOME into every test process; deleting it rather than restoring it
// would leave anything that resolves a store path afterwards pointing at the
// operator's real ~/.buildd.
const injectedHome = process.env.BUILDD_HOME;
const home = mkdtempSync(join(tmpdir(), 'buildd-home-cleanup-'));
process.env.BUILDD_HOME = home;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cleanupOldLogs } = require('../../src/session-logger');

const logsDir = join(home, 'logs');

afterAll(() => {
  if (injectedHome === undefined) delete process.env.BUILDD_HOME;
  else process.env.BUILDD_HOME = injectedHome;
  rmSync(home, { recursive: true, force: true });
});

function ageDaysAgo(path: string, days: number) {
  const past = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  utimesSync(path, past, past);
}

describe('cleanupOldLogs exempts claims.log', () => {
  test('an idle-runner-stale claims.log (mtime > 48h old) survives cleanup', () => {
    require('fs').mkdirSync(logsDir, { recursive: true });
    const claimsPath = join(logsDir, 'claims.log');
    writeFileSync(claimsPath, '{"ts":1}\n');
    ageDaysAgo(claimsPath, 5); // well past the 48h MAX_AGE_MS

    cleanupOldLogs();

    expect(existsSync(claimsPath)).toBe(true);
  });

  test('an equally stale per-worker log is still deleted', () => {
    require('fs').mkdirSync(logsDir, { recursive: true });
    const workerLogPath = join(logsDir, 'w-stale-1.log');
    writeFileSync(workerLogPath, '{"ts":1}\n');
    ageDaysAgo(workerLogPath, 5);

    cleanupOldLogs();

    expect(existsSync(workerLogPath)).toBe(false);
  });
});
