/**
 * The auto-update loop's two invariants:
 *
 *   1. A runner must never attempt an update to a commit it cannot reach.
 *   2. An attempt that does not move the commit is a FAILURE that stops retrying.
 *
 * Deliberately a NEW file rather than an addition to `updater.test.ts`: that file
 * installs a process-global `mock.module('child_process', ...)`, and the probe
 * teardown case here needs a real `Bun.spawn`ed child to kill.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  isUpdateTargetReachable,
  isNoProgressUpdate,
  canAttemptAutoUpdate,
  shouldShowUpdateAvailable,
  isAutoUpdateDisabled,
  reapChild,
  AUTO_UPDATE_RETRY_LIMIT,
} from '../../src/updater';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

describe('isUpdateTargetReachable', () => {
  test('false when the target is not the tracked branch head', () => {
    // The production shape: the server advertises a `dev` HEAD to a runner that
    // tracks `main`. `git reset --hard origin/main` can never land on it.
    expect(isUpdateTargetReachable(SHA_B, SHA_C, SHA_A)).toBe(false);
  });

  test('true only when the target IS the tracked branch head and differs from current', () => {
    expect(isUpdateTargetReachable(SHA_B, SHA_B, SHA_A)).toBe(true);
  });

  test('false when the target equals the current commit', () => {
    // Nothing to act on — this is the state a runner sitting exactly at
    // origin/main HEAD is in, and acting on it is the no-op reset.
    expect(isUpdateTargetReachable(SHA_A, SHA_A, SHA_A)).toBe(false);
  });

  test('false on any null input', () => {
    expect(isUpdateTargetReachable(null, SHA_B, SHA_A)).toBe(false);
    expect(isUpdateTargetReachable(SHA_B, null, SHA_A)).toBe(false);
    expect(isUpdateTargetReachable(SHA_B, SHA_B, null)).toBe(false);
  });
});

describe('isNoProgressUpdate', () => {
  test('true when the SHA did not move', () => {
    expect(isNoProgressUpdate(SHA_A, SHA_A)).toBe(true);
  });

  test('false when the SHA moved', () => {
    expect(isNoProgressUpdate(SHA_A, SHA_B)).toBe(false);
  });

  test('true when either SHA is unknown', () => {
    // An unreadable HEAD cannot evidence progress, so it must not be read as
    // success — that is what turned a no-op reset into a restart.
    expect(isNoProgressUpdate(null, SHA_B)).toBe(true);
    expect(isNoProgressUpdate(SHA_A, null)).toBe(true);
    expect(isNoProgressUpdate(null, null)).toBe(true);
  });
});

describe('canAttemptAutoUpdate', () => {
  const base = {
    target: SHA_B,
    skipped: new Set<string>(),
    retriesSpent: 0,
    spentAgainstCommit: SHA_B,
    lastIdleAt: 1_000,
    now: 1_000 + 5 * 60_000,
    idleDelayMs: 5 * 60_000,
  };

  test('allows when idle long enough with budget left', () => {
    expect(canAttemptAutoUpdate(base)).toBe(true);
  });

  test('refuses a target in the skip set', () => {
    // The latch: once a target proved it does not move HEAD, it is never
    // retried — not even after a restart re-arms the retry counter.
    expect(canAttemptAutoUpdate({ ...base, skipped: new Set([SHA_B]) })).toBe(false);
  });

  test('refuses at or over the retry cap', () => {
    expect(canAttemptAutoUpdate({ ...base, retriesSpent: AUTO_UPDATE_RETRY_LIMIT })).toBe(false);
    expect(canAttemptAutoUpdate({ ...base, retriesSpent: AUTO_UPDATE_RETRY_LIMIT + 1 })).toBe(false);
  });

  test('refuses before the idle delay has elapsed', () => {
    expect(canAttemptAutoUpdate({ ...base, now: 1_000 + 60_000 })).toBe(false);
    expect(canAttemptAutoUpdate({ ...base, lastIdleAt: null })).toBe(false);
  });

  test('refuses an unknown target', () => {
    expect(canAttemptAutoUpdate({ ...base, target: null })).toBe(false);
  });

  test('a newer target re-arms the budget but the skip set still wins', () => {
    const spent = { ...base, retriesSpent: AUTO_UPDATE_RETRY_LIMIT, target: SHA_C, spentAgainstCommit: SHA_B };
    expect(canAttemptAutoUpdate(spent)).toBe(true);
    expect(canAttemptAutoUpdate({ ...spent, skipped: new Set([SHA_C]) })).toBe(false);
  });
});

describe('shouldShowUpdateAvailable', () => {
  test('an unreachable target is never advertised, even when the changelog is unreliable', () => {
    // The "when in doubt, advertise" bias is correct for a reachable target and
    // exactly wrong for one the runner cannot check out.
    expect(shouldShowUpdateAvailable([], false, false)).toBe(false);
    expect(shouldShowUpdateAvailable(['fix: something'], true, false)).toBe(false);
    expect(shouldShowUpdateAvailable(['fix: something'], false, false)).toBe(false);
  });

  test('a reachable target keeps the existing bias', () => {
    expect(shouldShowUpdateAvailable([], false, true)).toBe(true);
    expect(shouldShowUpdateAvailable(['fix: something'], true, true)).toBe(true);
    expect(shouldShowUpdateAvailable([], true, true)).toBe(false);
  });
});

describe('isAutoUpdateDisabled', () => {
  test('defaults to enabled so behaviour is unchanged without the flag', () => {
    expect(isAutoUpdateDisabled({})).toBe(false);
    expect(isAutoUpdateDisabled({ BUILDD_DISABLE_AUTO_UPDATE: '' })).toBe(false);
    expect(isAutoUpdateDisabled({ BUILDD_DISABLE_AUTO_UPDATE: '0' })).toBe(false);
    expect(isAutoUpdateDisabled({ BUILDD_DISABLE_AUTO_UPDATE: 'false' })).toBe(false);
  });

  test('accepts the usual truthy spellings', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
      expect(isAutoUpdateDisabled({ BUILDD_DISABLE_AUTO_UPDATE: v })).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Probe teardown.
//
// How the signal-ignoring child is simulated: a real temp-dir script run by a
// real `Bun.spawn(['bun', 'run', ...])`, which registers
// `process.on('SIGTERM', () => {})` and holds an interval so the event loop
// never drains. That is exactly the live shape — `CredentialBroker.start()`
// registers a SIGTERM handler that never calls `process.exit`, and the probe
// keeps `Bun.serve` plus its timers alive — so SIGTERM is delivered, handled,
// and terminal for nothing. Only SIGKILL is uncatchable.
// ---------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'buildd-reap-'));
afterAll(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

function spawnSigtermIgnoringChild(): { proc: ReturnType<typeof Bun.spawn>; pid: number } {
  const script = join(scratch, `ignore-sigterm-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(
    script,
    [
      "process.on('SIGTERM', () => { /* handled, deliberately does not exit */ });",
      "process.on('SIGINT', () => { /* ditto */ });",
      'setInterval(() => {}, 1000);',
      "console.log('ready');",
    ].join('\n'),
  );
  const proc = Bun.spawn(['bun', 'run', script], { stdout: 'pipe', stderr: 'pipe' });
  return { proc, pid: proc.pid };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('reapChild', () => {
  test('resolves within a bounded time even when the child ignores SIGTERM, and leaves no surviving child', async () => {
    const { proc, pid } = spawnSigtermIgnoringChild();
    // Let the child install its handlers before signalling it.
    await new Promise(r => setTimeout(r, 1200));
    expect(isAlive(pid)).toBe(true);

    const startedAt = Date.now();
    const result = await reapChild(proc, { termGraceMs: 300, killGraceMs: 3_000 });
    const elapsed = Date.now() - startedAt;

    // Bounded: never the unbounded `await proc.exited` that parked twelve
    // attempts in teardown for hours.
    expect(elapsed).toBeLessThan(3_500);
    expect(result.escalated).toBe(true);
    expect(result.exited).toBe(true);
    expect(isAlive(pid)).toBe(false);
  }, 15_000);

  test('a child that exits on SIGTERM is reaped without escalating', async () => {
    const proc = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)'], { stdout: 'pipe', stderr: 'pipe' });
    await new Promise(r => setTimeout(r, 600));
    const result = await reapChild(proc, { termGraceMs: 3_000, killGraceMs: 3_000 });
    expect(result.exited).toBe(true);
    expect(result.escalated).toBe(false);
  }, 15_000);

  test('an already-exited child is a no-op', async () => {
    const proc = Bun.spawn(['bun', '-e', 'process.exit(3)'], { stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(3);
    const result = await reapChild(proc, { termGraceMs: 50, killGraceMs: 50 });
    expect(result).toEqual({ exited: true, escalated: false });
  }, 15_000);
});
