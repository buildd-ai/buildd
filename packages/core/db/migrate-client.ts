// The SQL half of db/migrate.ts, split out so the statements can be rendered
// and asserted in a unit test without a database connection. (There is no test
// DB for the migrator: DATABASE_URL points at a shared branch and CLAUDE.md
// forbids running migrations against it from a dev machine.)

import { sql, type SQL } from 'drizzle-orm';
import { emptyDbShape, type DbShape } from './migrate-backfill';
import type { MigrationLockDriver } from './migrate-lock';
import type { MigrationFile } from './migrate-plan';

export const SCHEMA = 'drizzle';
export const TABLE = '__drizzle_migrations';
export const LOCK_TABLE = '__buildd_migrate_lock';

/**
 * The subset of drizzle's neon-http session this file uses. Narrow on purpose:
 * `transaction()` is deliberately absent because the neon-http driver throws
 * "No transactions support in neon-http driver" if you call it.
 */
export interface MigrateSession {
  execute(query: SQL): Promise<unknown>;
  all(query: SQL): Promise<unknown[]>;
}

export async function ensureTrackingTable(session: MigrateSession): Promise<void> {
  await session.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(SCHEMA)}`);
  await session.execute(sql`
    CREATE TABLE IF NOT EXISTS ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

export async function readAppliedRows(
  session: MigrateSession
): Promise<{ created_at: string | number }[]> {
  return (await session.all(
    sql`SELECT created_at FROM ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)}`
  )) as { created_at: string | number }[];
}

export async function recordApplied(
  session: MigrateSession,
  migration: MigrationFile
): Promise<void> {
  await session.execute(
    sql`INSERT INTO ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (hash, created_at)
        VALUES (${migration.hash}, ${migration.folderMillis})`
  );
}

/**
 * Introspect the live schema so the backfill can prove — rather than assume —
 * that an untracked old migration's DDL is already there. Only called when
 * there is something to backfill; the normal path pays nothing for it.
 */
export async function readDbShape(session: MigrateSession): Promise<DbShape> {
  const shape = emptyDbShape();

  const tables = (await session.all(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  )) as { table_name: string }[];
  for (const row of tables) shape.tables.add(row.table_name);

  const columns = (await session.all(
    sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
  )) as { table_name: string; column_name: string }[];
  for (const row of columns) shape.columns.add(`${row.table_name}.${row.column_name}`);

  const indexes = (await session.all(
    sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
  )) as { indexname: string }[];
  for (const row of indexes) shape.indexes.add(row.indexname);

  const constraints = (await session.all(
    sql`SELECT table_name, constraint_name FROM information_schema.table_constraints WHERE table_schema = 'public'`
  )) as { table_name: string; constraint_name: string }[];
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
      await session.execute(sql`
        CREATE TABLE IF NOT EXISTS ${sql.identifier(SCHEMA)}.${sql.identifier(LOCK_TABLE)} (
          id integer PRIMARY KEY,
          holder text NOT NULL,
          acquired_at timestamptz NOT NULL DEFAULT now()
        )
      `);
    },
    async tryAcquire(holder, staleAfterMs) {
      const staleSeconds = Math.max(1, Math.floor(staleAfterMs / 1000));
      // ONE statement, so Postgres serialises the racers: the winner gets a row
      // back, the loser gets none. DO UPDATE fires only for a lock older than
      // the staleness window, so a crashed migrator cannot wedge deploys.
      // staleSeconds is interpolated raw (it is Math.floor of a number, not
      // user input) because a bound parameter inside make_interval's named
      // argument has no inferable type.
      const rows = (await session.all(sql`
        INSERT INTO ${sql.identifier(SCHEMA)}.${sql.identifier(LOCK_TABLE)} (id, holder, acquired_at)
        VALUES (1, ${holder}, now())
        ON CONFLICT (id) DO UPDATE
          SET holder = ${holder}, acquired_at = now()
          WHERE ${sql.identifier(LOCK_TABLE)}.acquired_at < now() - make_interval(secs => ${sql.raw(String(staleSeconds))})
        RETURNING holder
      `)) as { holder: string }[];
      return rows.length > 0;
    },
    async release(holder) {
      await session.execute(sql`
        DELETE FROM ${sql.identifier(SCHEMA)}.${sql.identifier(LOCK_TABLE)}
        WHERE id = 1 AND holder = ${holder}
      `);
    },
    async describeHolder() {
      const rows = (await session.all(sql`
        SELECT holder, acquired_at
        FROM ${sql.identifier(SCHEMA)}.${sql.identifier(LOCK_TABLE)}
        WHERE id = 1
      `)) as { holder: string; acquired_at: string }[];
      const row = rows[0];
      return row ? { holder: row.holder, acquiredAtIso: String(row.acquired_at) } : null;
    },
  };
}
