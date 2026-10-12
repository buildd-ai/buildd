// The SQL half of db/migrate.ts, split out so the statements can be rendered
// and asserted in a unit test without a database connection. (There is no test
// DB for the migrator: DATABASE_URL points at a shared branch and CLAUDE.md
// forbids running migrations against it from a dev machine.)

import { sql, type SQL } from 'drizzle-orm';
import { emptyDbShape, type DbShape } from './migrate-backfill';
import type { MigrationLockDriver } from './migrate-lock';
import type { MigrationFile, TrackingRow } from './migrate-plan';

export const SCHEMA = 'drizzle';
export const TABLE = '__drizzle_migrations';
export const LOCK_TABLE = '__buildd_migrate_lock';

/**
 * The one method of drizzle's neon-http database this file uses: the public
 * `db.execute`. Narrow on purpose: `transaction()` is deliberately absent
 * because the neon-http driver throws "No transactions support in neon-http
 * driver" if you call it.
 *
 * Rows are read from `execute`'s full result rather than through the
 * session's `all()`: `all()` is internal and drizzle v1 removed it (its
 * session has `objects()` instead), so a call to it compiles through a cast
 * and fails at runtime. `execute` returns `{ rows, ... }` on both 0.45 and v1
 * (pinned in __tests__/migrate-driver-contract.test.ts).
 */
export interface MigrateSession {
  execute(query: SQL): PromiseLike<unknown>;
}

/**
 * Run a query and return its rows. Throws on a result with no `rows` array
 * rather than returning `[]`: an empty applied-set reads as an empty database,
 * and the migrator would then try to replay the baseline over a live schema.
 */
export async function queryRows<T>(session: MigrateSession, query: SQL): Promise<T[]> {
  const result = await session.execute(query);
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  if (!Array.isArray(rows)) {
    throw new Error(
      'migrator: db.execute() returned no rows array. The drizzle driver changed its result shape; ' +
        'refusing to read that as "no rows".'
    );
  }
  return rows as T[];
}

// `CREATE ... IF NOT EXISTS` is not safe under concurrency in Postgres: two
// sessions that both see the object missing both try to create it, and the
// loser fails with a duplicate (on the catalog's unique index, or as
// duplicate_table/duplicate_object/duplicate_schema). Two deploys migrating an
// empty database at once hit exactly that, before the migration lock (whose
// own table is created the same way) can serialise them.
const CONCURRENT_CREATE_CODES = new Set(['23505', '42P07', '42710', '42P06']);

export function isConcurrentCreateError(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' && CONCURRENT_CREATE_CODES.has(code);
}

/**
 * Run an idempotent CREATE ... IF NOT EXISTS, retrying once if a concurrent
 * session created the object first: by then it is committed, so the retry is
 * a no-op. Any other error, or a second failure, propagates.
 */
export async function createIfNotExists(session: MigrateSession, query: SQL): Promise<void> {
  try {
    await session.execute(query);
  } catch (err) {
    if (!isConcurrentCreateError(err)) throw err;
    await session.execute(query);
  }
}

/**
 * Create the tracking table if it does not exist, in drizzle v1's shape: the
 * old `id, hash, created_at` plus `name` and `applied_at`. Both are nullable,
 * so the old migrator (which writes only hash and created_at) still works on
 * it. On an existing table this is a no-op: it runs before the pre-baseline
 * guard, which must leave a refused database untouched.
 */
export async function ensureTrackingTable(session: MigrateSession): Promise<void> {
  await createIfNotExists(session, sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(SCHEMA)}`);
  await createIfNotExists(
    session,
    sql`
    CREATE TABLE IF NOT EXISTS ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint,
      name text,
      applied_at timestamptz DEFAULT now()
    )
  `
  );
}

async function trackingColumns(session: MigrateSession): Promise<Set<string>> {
  const rows = await queryRows<{ column_name: string }>(
    session,
    sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${SCHEMA} AND table_name = ${TABLE}`
  );
  return new Set(rows.map((r) => r.column_name));
}

/**
 * Every tracking row with its name. Reads an old-shape table (no `name`
 * column, i.e. not yet upgraded) without altering it: the plan, and with it the
 * pre-baseline guard, runs before the upgrade.
 */
export async function readTrackingRows(session: MigrateSession): Promise<TrackingRow[]> {
  const hasName = (await trackingColumns(session)).has('name');
  const table = sql`${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)}`;
  return await queryRows<TrackingRow>(
    session,
    hasName
      ? sql`SELECT name, hash, created_at FROM ${table}`
      : sql`SELECT NULL::text AS name, hash, created_at FROM ${table}`
  );
}

/**
 * Bring an old-shape tracking table up to the v1 shape and name the legacy rows
 * the plan matched by exact-ms created_at. Our own code: drizzle's stock
 * `upgradeIfNeeded` throws on rows that match no local folder, which our
 * append-only table always has.
 *
 * Additive and idempotent: columns are added only if missing, and only rows
 * whose name is still NULL are named, so a second run writes nothing. Nothing
 * existing is altered, which is what lets the previous release's migrator run
 * on the upgraded table (rollback). Call it only after planMigrationsV1 has
 * passed the pre-baseline guard.
 */
export async function upgradeTrackingTable(
  session: MigrateSession,
  nameUpdates: ReadonlyArray<{ when: number; name: string }>
): Promise<void> {
  const columns = await trackingColumns(session);
  const table = sql`${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)}`;
  if (!columns.has('name') || !columns.has('applied_at')) {
    await session.execute(sql`
      ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS name text,
        ADD COLUMN IF NOT EXISTS applied_at timestamptz
    `);
    // Separately, so existing rows keep applied_at NULL ("before names existed")
    // instead of all reading as applied at upgrade time.
    await session.execute(sql`ALTER TABLE ${table} ALTER COLUMN applied_at SET DEFAULT now()`);
  }
  if (nameUpdates.length === 0) return;
  const values = sql.join(
    nameUpdates.map((u) => sql`(${u.when}::bigint, ${u.name}::text)`),
    sql`, `
  );
  await session.execute(sql`UPDATE ${table} t SET name = v.name
    FROM (VALUES ${values}) AS v(created_at, name)
    WHERE t.created_at = v.created_at AND t.name IS NULL`);
}

export async function readAppliedRows(
  session: MigrateSession
): Promise<{ created_at: string | number }[]> {
  return await queryRows<{ created_at: string | number }>(
    session,
    sql`SELECT created_at FROM ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)}`
  );
}

/**
 * The tracking INSERT. With a name (the v1 path) it writes the v1 row; without
 * one, the old two-column row, which an old-shape table can take.
 */
export function trackingInsert(migration: MigrationFile & { name?: string }): SQL {
  const table = sql`${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)}`;
  return migration.name
    ? sql`INSERT INTO ${table} (hash, created_at, name, applied_at)
        VALUES (${migration.hash}, ${migration.folderMillis}, ${migration.name}, now())`
    : sql`INSERT INTO ${table} (hash, created_at)
        VALUES (${migration.hash}, ${migration.folderMillis})`;
}

export async function recordApplied(
  session: MigrateSession,
  migration: MigrationFile & { name?: string }
): Promise<void> {
  await session.execute(trackingInsert(migration));
}

/**
 * Introspect the live schema so the backfill can prove — rather than assume —
 * that an untracked old migration's DDL is already there. Only called when
 * there is something to backfill; the normal path pays nothing for it.
 */
export async function readDbShape(session: MigrateSession): Promise<DbShape> {
  const shape = emptyDbShape();

  const tables = await queryRows<{ table_name: string }>(
    session,
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  for (const row of tables) shape.tables.add(row.table_name);

  const columns = await queryRows<{ table_name: string; column_name: string }>(
    session,
    sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
  );
  for (const row of columns) shape.columns.add(`${row.table_name}.${row.column_name}`);

  const indexes = await queryRows<{ indexname: string }>(
    session,
    sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
  );
  for (const row of indexes) shape.indexes.add(row.indexname);

  const constraints = await queryRows<{ table_name: string; constraint_name: string }>(
    session,
    sql`SELECT table_name, constraint_name FROM information_schema.table_constraints WHERE table_schema = 'public'`
  );
  for (const row of constraints) shape.constraints.add(`${row.table_name}.${row.constraint_name}`);

  return shape;
}

/**
 * Lock-row driver. See migrate-lock.ts for why this is not `pg_advisory_lock`:
 * the migrator runs on the neon HTTP driver, which cannot hold session state,
 * so exclusion has to come from one atomic statement rather than a session lock.
 */
export function lockDriver(session: MigrateSession): MigrationLockDriver {
  return {
    async ensureTable() {
      await createIfNotExists(
        session,
        sql`
        CREATE TABLE IF NOT EXISTS ${sql.identifier(SCHEMA)}.${sql.identifier(LOCK_TABLE)} (
          id integer PRIMARY KEY,
          holder text NOT NULL,
          acquired_at timestamptz NOT NULL DEFAULT now()
        )
      `
      );
    },
    async tryAcquire(holder, staleAfterMs) {
      const staleSeconds = Math.max(1, Math.floor(staleAfterMs / 1000));
      // ONE statement, so Postgres serialises the racers: the winner gets a row
      // back, the loser gets none. DO UPDATE fires only for a lock older than
      // the staleness window, so a crashed migrator cannot wedge deploys.
      // staleSeconds is interpolated raw (it is Math.floor of a number, not
      // user input) because a bound parameter inside make_interval's named
      // argument has no inferable type.
      const rows = await queryRows<{ holder: string }>(session, sql`
        INSERT INTO ${sql.identifier(SCHEMA)}.${sql.identifier(LOCK_TABLE)} (id, holder, acquired_at)
        VALUES (1, ${holder}, now())
        ON CONFLICT (id) DO UPDATE
          SET holder = ${holder}, acquired_at = now()
          WHERE ${sql.identifier(LOCK_TABLE)}.acquired_at < now() - make_interval(secs => ${sql.raw(String(staleSeconds))})
        RETURNING holder
      `);
      return rows.length > 0;
    },
    async release(holder) {
      await session.execute(sql`
        DELETE FROM ${sql.identifier(SCHEMA)}.${sql.identifier(LOCK_TABLE)}
        WHERE id = 1 AND holder = ${holder}
      `);
    },
    async describeHolder() {
      const rows = await queryRows<{ holder: string; acquired_at: string }>(session, sql`
        SELECT holder, acquired_at
        FROM ${sql.identifier(SCHEMA)}.${sql.identifier(LOCK_TABLE)}
        WHERE id = 1
      `);
      const row = rows[0];
      return row ? { holder: row.holder, acquiredAtIso: String(row.acquired_at) } : null;
    },
  };
}
