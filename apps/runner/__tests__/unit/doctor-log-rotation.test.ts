/**
 * Regression guard: the runner's stdout log (~0.5MB/day, no rotation) was
 * only ever touched by doctor.ts's `fixRunnerLog`, which cleared it with
 * `echo ... > logPath` — destroying the forensic record instead of rotating
 * it. This tests the replacement: real copy-then-truncate rotation.
 *
 * copy-then-truncate (not rename-then-recreate) is required because the log
 * file is stdout redirected by an external wrapper (`>> logPath`) that holds
 * the fd open for the runner's whole lifetime — renaming the path away would
 * not give the still-running process a new fd at the old name. Truncating in
 * place is safe for an O_APPEND writer: each write() re-seeks to EOF first,
 * so truncating to 0 correctly resumes appends from offset 0 with no gap.
 *
 * The log path is overridable via BUILDD_RUNNER_LOG_PATH so this never
 * touches the real /tmp/buildd.log.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/doctor-log-rotation.test.ts
 */

import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dir = mkdtempSync(join(tmpdir(), 'buildd-runner-log-'));
const logPath = join(dir, 'buildd.log');
process.env.BUILDD_RUNNER_LOG_PATH = logPath;
process.env.BUILDD_HOME = mkdtempSync(join(tmpdir(), 'buildd-home-doctor-'));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rotateLogIfLarge } = require('../../src/doctor');

afterAll(() => {
  delete process.env.BUILDD_RUNNER_LOG_PATH;
  delete process.env.BUILDD_HOME;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  try { rmSync(logPath); } catch {}
  try { rmSync(`${logPath}.1`); } catch {}
});

describe('rotateLogIfLarge', () => {
  test('below the threshold: no rotation, content untouched', () => {
    writeFileSync(logPath, 'small content\n');
    const result = rotateLogIfLarge(logPath, 1_000_000);
    expect(result.rotated).toBe(false);
    expect(readFileSync(logPath, 'utf-8')).toBe('small content\n');
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  test('over the threshold: content is preserved in a .1 backup, live file truncated to empty', () => {
    const big = 'x'.repeat(2000) + '\n';
    writeFileSync(logPath, big);
    const result = rotateLogIfLarge(logPath, 1000);

    expect(result.rotated).toBe(true);
    expect(statSync(logPath).size).toBe(0);
    expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe(big);
  });

  test('a second rotation overwrites the prior .1 backup rather than accumulating', () => {
    writeFileSync(logPath, 'first-batch-' + 'x'.repeat(2000));
    rotateLogIfLarge(logPath, 1000);
    expect(readFileSync(`${logPath}.1`, 'utf-8')).toContain('first-batch-');

    writeFileSync(logPath, 'second-batch-' + 'x'.repeat(2000));
    rotateLogIfLarge(logPath, 1000);
    const backup = readFileSync(`${logPath}.1`, 'utf-8');
    expect(backup).toContain('second-batch-');
    expect(backup).not.toContain('first-batch-');
  });

  test('missing file: no-op, does not throw', () => {
    const result = rotateLogIfLarge(logPath, 1000);
    expect(result.rotated).toBe(false);
  });
});
