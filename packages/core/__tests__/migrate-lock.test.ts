import { describe, it, expect } from 'bun:test';
import {
  withMigrationLock,
  MigrationLockTimeoutError,
  type MigrationLockDriver,
} from '../db/migrate-lock';

/**
 * Regression guard for finding C11: two concurrent deploys racing the migrator.
 *
 * `db/migrate.ts` reads __drizzle_migrations, then applies. Two racers both read
 * before either writes, so both compute the same `toRun` and both execute it.
 * The tracking table has no unique constraint, so the duplicate rows insert
 * cleanly and provide no exclusion, and 142 committed `ADD COLUMN` statements
 * lack `IF NOT EXISTS`, so the loser dies mid-file — leaving a multi-statement
 * migration half-applied underneath a tracking row that claims success.
 *
 * A session-level `pg_advisory_lock` is NOT available here: the migrator runs on
 * @neondatabase/serverless's HTTP `neon()` function, where (README, "Sessions,
 * transactions, and node-postgres compatibility") "you can only send one query
 * at a time this way: sessions and transactions are not supported" — a session
 * lock taken in one HTTP request is gone by the next. So the exclusion is a lock
 * ROW acquired by a single atomic conditional upsert, with a stale-holder
 * takeover so a crashed migrator cannot wedge deploys forever. These tests pin
 * the two properties that matter: the body never runs without the lock, and the
 * lock is always released.
 */

interface FakeState {
  holder: string | null;
  acquiredAt: number;
}

/**
 * Simulates the atomicity of the real acquire statement: a single row keyed on
 * id=1, takeable only when free or stale.
 */
function fakeDriver(state: FakeState, now = () => 1_000_000) {
  const calls = { ensure: 0, acquire: 0, release: 0 };
  const driver: MigrationLockDriver = {
    async ensureTable() {
      calls.ensure++;
    },
    async tryAcquire(holder, staleAfterMs) {
      calls.acquire++;
      const free = state.holder === null;
      const stale = state.holder !== null && now() - state.acquiredAt >= staleAfterMs;
      if (!free && !stale) return false;
      state.holder = holder;
      state.acquiredAt = now();
      return true;
    },
    async release(holder) {
      calls.release++;
      if (state.holder === holder) state.holder = null;
    },
    async describeHolder() {
      return state.holder === null
        ? null
        : { holder: state.holder, acquiredAtIso: new Date(state.acquiredAt).toISOString() };
    },
  };
  return { driver, calls };
}

describe('withMigrationLock', () => {
  it('runs the body while holding the lock and releases it afterwards', async () => {
    const state: FakeState = { holder: null, acquiredAt: 0 };
    const { driver, calls } = fakeDriver(state);
    const heldDuringBody: Array<string | null> = [];

    const result = await withMigrationLock(driver, { holder: 'runner-a' }, async () => {
      heldDuringBody.push(state.holder);
      return 'done';
    });

    expect(result).toBe('done');
    expect(heldDuringBody).toEqual(['runner-a']);
    expect(state.holder).toBeNull();
    expect(calls.release).toBe(1);
    expect(calls.ensure).toBe(1);
  });

  it('releases the lock and rethrows when the body fails', async () => {
    const state: FakeState = { holder: null, acquiredAt: 0 };
    const { driver, calls } = fakeDriver(state);

    await expect(
      withMigrationLock(driver, { holder: 'runner-a' }, async () => {
        throw new Error('migration 0119 failed');
      }),
    ).rejects.toThrow('migration 0119 failed');

    expect(state.holder).toBeNull();
    expect(calls.release).toBe(1);
  });

  it('NEVER runs the body when the lock is held by someone else', async () => {
    const state: FakeState = { holder: 'runner-a', acquiredAt: 1_000_000 };
    const { driver } = fakeDriver(state);
    let bodyRan = false;

    await expect(
      withMigrationLock(
        driver,
        { holder: 'runner-b', waitTimeoutMs: 30, retryDelayMs: 5, sleep: async () => {} },
        async () => {
          bodyRan = true;
        },
      ),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

    expect(bodyRan).toBe(false);
    // The loser must not steal or clear the winner's lock.
    expect(state.holder).toBe('runner-a');
  });

  it('names the current holder in the timeout error so a wedged deploy is diagnosable', async () => {
    const state: FakeState = { holder: 'runner-a', acquiredAt: 1_000_000 };
    const { driver } = fakeDriver(state);

    let message = '';
    try {
      await withMigrationLock(
        driver,
        { holder: 'runner-b', waitTimeoutMs: 10, retryDelayMs: 5, sleep: async () => {} },
        async () => {},
      );
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('runner-a');
  });

  it('acquires once the other holder releases', async () => {
    const state: FakeState = { holder: 'runner-a', acquiredAt: 1_000_000 };
    const { driver, calls } = fakeDriver(state);
    let attempts = 0;

    const result = await withMigrationLock(
      driver,
      {
        holder: 'runner-b',
        waitTimeoutMs: 10_000,
        retryDelayMs: 1,
        sleep: async () => {
          attempts++;
          if (attempts === 3) state.holder = null; // runner-a finishes
        },
      },
      async () => 'applied',
    );

    expect(result).toBe('applied');
    expect(calls.acquire).toBeGreaterThan(1);
    expect(state.holder).toBeNull();
  });

  it('takes over a stale lock left by a crashed migrator', async () => {
    // Held far longer than the staleness window: the holder is gone, not slow.
    const state: FakeState = { holder: 'crashed-runner', acquiredAt: 0 };
    const { driver } = fakeDriver(state, () => 10_000_000);
    let bodyRan = false;

    await withMigrationLock(
      driver,
      { holder: 'runner-b', staleAfterMs: 60_000, sleep: async () => {} },
      async () => {
        bodyRan = true;
      },
    );

    expect(bodyRan).toBe(true);
  });

  it('does not release a lock it never acquired', async () => {
    const state: FakeState = { holder: 'runner-a', acquiredAt: 1_000_000 };
    const { driver, calls } = fakeDriver(state);

    await expect(
      withMigrationLock(
        driver,
        { holder: 'runner-b', waitTimeoutMs: 10, retryDelayMs: 5, sleep: async () => {} },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

    expect(calls.release).toBe(0);
  });

  it('surfaces the body result even if releasing the lock fails', async () => {
    const state: FakeState = { holder: null, acquiredAt: 0 };
    const { driver } = fakeDriver(state);
    driver.release = async () => {
      throw new Error('connection dropped during release');
    };

    // A release failure must not turn a successful migration run into a failed
    // deploy — the stale-takeover path recovers the lock.
    const result = await withMigrationLock(driver, { holder: 'runner-a' }, async () => 'ok');
    expect(result).toBe('ok');
  });
});
