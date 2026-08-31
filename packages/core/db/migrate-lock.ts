// Mutual exclusion for db/migrate.ts.
//
// Why not pg_advisory_lock: the migrator runs on the @neondatabase/serverless
// HTTP driver (`import { drizzle } from 'drizzle-orm/neon-http'` +
// `neon(config.databaseUrl)` in db/migrate.ts). Every query is an independent
// https fetch — per that package's README, "you can only send one query at a
// time this way: sessions and transactions are not supported". A session-scoped
// `pg_advisory_lock()` taken in one request is therefore released before the
// next request runs, and `pg_advisory_xact_lock()` would require the whole apply
// loop inside one transaction, which this driver cannot do either. Calling
// pg_advisory_lock here would look like protection and provide none.
//
// What is genuinely available over a stateless HTTP connection is a lock ROW
// taken by a single atomic statement:
//
//   INSERT INTO drizzle.__buildd_migrate_lock (id, holder, acquired_at)
//   VALUES (1, $holder, now())
//   ON CONFLICT (id) DO UPDATE SET holder = $holder, acquired_at = now()
//     WHERE __buildd_migrate_lock.acquired_at < now() - $stale
//   RETURNING holder
//
// One statement, so Postgres serialises it: exactly one caller gets a row back
// when the lock is free, and the loser sees zero rows. The `WHERE` clause on the
// DO UPDATE gives stale takeover, so a migrator that crashed mid-run (or a
// Vercel build killed by a timeout) cannot wedge every future deploy — the price
// is that "held" is time-bounded rather than connection-bounded, which is the
// best a stateless driver can offer.
//
// The lock table lives in the `drizzle` schema next to __drizzle_migrations, not
// in `public`, so scripts/check-schema-drift.ts (which introspects
// table_schema = 'public') does not see it as untracked manual DDL.

export interface MigrationLockDriver {
  /** Creates the lock table if it does not exist. */
  ensureTable(): Promise<void>;
  /** Atomically takes the lock. Returns false when another live holder has it. */
  tryAcquire(holder: string, staleAfterMs: number): Promise<boolean>;
  /** Releases the lock, but only if `holder` still owns it. */
  release(holder: string): Promise<void>;
  /** For diagnostics when acquisition times out. */
  describeHolder(): Promise<{ holder: string; acquiredAtIso: string } | null>;
}

export interface MigrationLockOptions {
  holder: string;
  /** How long to wait for another migrator to finish. Default 5 minutes. */
  waitTimeoutMs?: number;
  /** Delay between acquisition attempts. Default 3s. */
  retryDelayMs?: number;
  /** After this long, a held lock is assumed abandoned. Default 15 minutes. */
  staleAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export class MigrationLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationLockTimeoutError';
  }
}

const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 3_000;
// Longer than any migration this repo has ever taken, shorter than the window in
// which a wedged lock would block a hotfix.
const DEFAULT_STALE_AFTER_MS = 15 * 60_000;

/**
 * Run `body` with the migration lock held, or fail without running it.
 *
 * Failing is the point: proceeding unlocked is what lets two deploys interleave
 * `ADD COLUMN` statements that have no `IF NOT EXISTS`.
 */
export async function withMigrationLock<T>(
  driver: MigrationLockDriver,
  options: MigrationLockOptions,
  body: () => Promise<T>,
): Promise<T> {
  const {
    holder,
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    log = () => {},
  } = options;

  await driver.ensureTable();

  const deadline = Date.now() + waitTimeoutMs;
  let acquired = false;
  let attempts = 0;

  while (true) {
    attempts++;
    acquired = await driver.tryAcquire(holder, staleAfterMs);
    if (acquired) break;
    if (Date.now() >= deadline) break;
    if (attempts === 1) {
      log(`Migration lock held by another migrator — waiting up to ${waitTimeoutMs / 1000}s...`);
    }
    await sleep(retryDelayMs);
  }

  if (!acquired) {
    let current: Awaited<ReturnType<MigrationLockDriver['describeHolder']>> = null;
    try {
      current = await driver.describeHolder();
    } catch {
      // Diagnostics only — the timeout is the real outcome.
    }
    throw new MigrationLockTimeoutError(
      `Could not acquire the migration lock within ${waitTimeoutMs / 1000}s ` +
        `(${attempts} attempt(s)). Held by ${current ? `${current.holder} since ${current.acquiredAtIso}` : 'an unknown holder'}. ` +
        `Refusing to migrate concurrently: this repo has 142 committed ADD COLUMN statements ` +
        `without IF NOT EXISTS, so a second migrator would fail mid-file and leave a migration ` +
        `half-applied. If the holder is a dead deploy, wait for the staleness window ` +
        `(${staleAfterMs / 60_000}min) or clear drizzle.__buildd_migrate_lock by hand.`,
    );
  }

  log(`Migration lock acquired by ${holder} (attempt ${attempts})`);

  try {
    return await body();
  } finally {
    try {
      await driver.release(holder);
      log(`Migration lock released by ${holder}`);
    } catch (err) {
      // A failed release must not mask the body's outcome. The stale-takeover
      // window recovers the lock on its own.
      log(
        `WARNING: failed to release the migration lock (${(err as Error)?.message ?? err}). ` +
          `It will be reclaimed as stale after ${staleAfterMs / 60_000}min.`,
      );
    }
  }
}
