import { describe, expect, test } from 'bun:test';
import { UPDATE_STUCK_LIMIT_MS, isUpdateStuck, hasCommitDrift } from '../../src/updater';

/**
 * `updateState.updating` gates BOTH the auto-updater and the drift check, so a
 * flag stuck true silences both at once — which is precisely the production
 * failure these guards exist for: the working tree advances, the process keeps
 * its old modules, and nothing logs. Every path that sets the flag either exits
 * or clears it in a `catch`, but only for failures that *throw*; an `await` that
 * hangs (a `bun install` with no kill timeout, say) leaves it set forever.
 */
describe('isUpdateStuck', () => {
  const T = 1_000_000;

  test('a flag that is not set is never stuck', () => {
    expect(isUpdateStuck(false, null, T)).toBe(false);
    expect(isUpdateStuck(false, T - UPDATE_STUCK_LIMIT_MS * 10, T)).toBe(false);
  });

  // An un-instrumented caller must never be able to trigger a spurious unwedge.
  test('a missing timestamp is not stuck, even when the flag is set', () => {
    expect(isUpdateStuck(true, null, T)).toBe(false);
  });

  test('an update in progress but inside the limit is not stuck', () => {
    expect(isUpdateStuck(true, T - 1, T)).toBe(false);
    expect(isUpdateStuck(true, T - (UPDATE_STUCK_LIMIT_MS - 1), T)).toBe(false);
  });

  test('exactly at the limit counts as stuck', () => {
    expect(isUpdateStuck(true, T - UPDATE_STUCK_LIMIT_MS, T)).toBe(true);
  });

  test('past the limit is stuck', () => {
    expect(isUpdateStuck(true, T - UPDATE_STUCK_LIMIT_MS * 3, T)).toBe(true);
  });

  test('the limit is overridable for tests without touching the default', () => {
    expect(isUpdateStuck(true, T - 5_000, T, 10_000)).toBe(false);
    expect(isUpdateStuck(true, T - 15_000, T, 10_000)).toBe(true);
    expect(UPDATE_STUCK_LIMIT_MS).toBe(10 * 60_000);
  });

  // Clock skew or a timestamp written by a future process must not read as a
  // 'negative age' stuck state.
  test('a future timestamp is not stuck', () => {
    expect(isUpdateStuck(true, T + 60_000, T)).toBe(false);
  });
});

/**
 * The watchdog exists to unblock this. Pinned together so the coupling is
 * visible: if drift is detectable but the flag is stuck, nothing recovers.
 */
describe('the wedge the watchdog unblocks', () => {
  test('drift is detectable, so clearing a stuck flag is sufficient to recover', () => {
    expect(hasCommitDrift('aaaaaaa', 'bbbbbbb')).toBe(true);
    // ...but a stuck flag is what stops the drift branch from ever running,
    // and after the limit the watchdog clears it.
    const stuckSince = 1_000_000 - UPDATE_STUCK_LIMIT_MS;
    expect(isUpdateStuck(true, stuckSince, 1_000_000)).toBe(true);
  });

  test('unreadable git on either side never triggers a restart loop', () => {
    expect(hasCommitDrift(null, 'bbbbbbb')).toBe(false);
    expect(hasCommitDrift('aaaaaaa', null)).toBe(false);
    expect(hasCommitDrift(null, null)).toBe(false);
  });

  test('identical commits are not drift', () => {
    expect(hasCommitDrift('aaaaaaa', 'aaaaaaa')).toBe(false);
  });
});
