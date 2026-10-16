import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import {
  createIfNotExists,
  ensureTrackingTable,
  lockDriver,
  readDbShape,
  readTrackingRows,
  recordApplied,
  trackingInsert,
  upgradeTrackingTable,
  type MigrateSession,
} from '../db/migrate-client';

/**
 * The migrator's SQL, asserted without a database.
 *
 * There is no test DB available for the migrator (DATABASE_URL points at a
 * shared Neon branch and running migrations against it from a dev machine is
 * forbidden), so the statements are rendered through drizzle's own dialect and
 * inspected. That still catches the things that matter here: that the lock is a
 * single atomic statement rather than a read-then-write, that it is not a fake
 * `pg_advisory_lock` on a driver that cannot hold one, and that release is
 * scoped to the holder.
 */

const dialect = new PgDialect();

function capturingSession(rowsFor: (query: string) => unknown[] = () => []) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const session: MigrateSession = {
    // Shaped like neon-http's `db.execute` result on both drizzle 0.45 and v1:
    // the full query result, rows under `rows`.
    async execute(query: SQL) {
      const rendered = dialect.sqlToQuery(query);
      queries.push({ sql: rendered.sql, params: rendered.params });
      return { rows: rowsFor(rendered.sql) };
    },
  };
  return { session, queries };
}

describe('lockDriver SQL', () => {
  it('acquires with a single atomic upsert that returns a row only to the winner', async () => {
    const { session, queries } = capturingSession(() => [{ holder: 'runner-a' }]);
    const acquired = await lockDriver(session).tryAcquire('runner-a', 900_000);

    expect(acquired).toBe(true);
    expect(queries.length).toBe(1); // one statement — no read-then-write window

    const { sql, params } = queries[0]!;
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain('INSERT INTO "drizzle"."__buildd_migrate_lock"');
    expect(flat).toContain('ON CONFLICT (id) DO UPDATE');
    expect(flat).toContain('RETURNING holder');
    // Stale takeover, expressed in the same statement.
    expect(flat).toContain('make_interval(secs => 900)');
    // The holder is a bound parameter, not interpolated text.
    expect(params).toEqual(['runner-a', 'runner-a']);
  });

  it('reports the lock as unavailable when the statement returns no row', async () => {
    const { session } = capturingSession(() => []);
    expect(await lockDriver(session).tryAcquire('runner-b', 900_000)).toBe(false);
  });

  it('does not use pg_advisory_lock, which this driver cannot hold', async () => {
    const { session, queries } = capturingSession(() => [{ holder: 'x' }]);
    const driver = lockDriver(session);
    await driver.ensureTable();
    await driver.tryAcquire('x', 900_000);
    await driver.release('x');
    await driver.describeHolder();

    const all = queries.map((q) => q.sql).join(' ');
    // neon-http sends each query as an independent https fetch: "sessions and
    // transactions are not supported" (@neondatabase/serverless README). A
    // session-level advisory lock would be released before the next statement,
    // so calling one here would look like protection and provide none.
    expect(all).not.toContain('pg_advisory_lock');
    expect(all).not.toContain('pg_advisory_xact_lock');
  });

  it('releases only its own lock row', async () => {
    const { session, queries } = capturingSession();
    await lockDriver(session).release('runner-a');

    const { sql, params } = queries[0]!;
    expect(sql.replace(/\s+/g, ' ')).toContain('WHERE id = 1 AND holder = $1');
    expect(params).toEqual(['runner-a']);
  });

  it('creates the lock table in the drizzle schema, not public', async () => {
    const { session, queries } = capturingSession();
    await lockDriver(session).ensureTable();
    // scripts/check-schema-drift.ts introspects table_schema = 'public'; a lock
    // table there would be reported as untracked manual DDL every release.
    expect(queries[0]!.sql).toContain('"drizzle"."__buildd_migrate_lock"');
  });
});

describe('readDbShape', () => {
  it('maps introspection rows into the assertion targets the backfill checks', async () => {
    const session: MigrateSession = {
      async execute(query: SQL) {
        const sql = dialect.sqlToQuery(query).sql;
        if (sql.includes('information_schema.tables')) return { rows: [{ table_name: 'tasks' }] };
        if (sql.includes('information_schema.columns')) {
          return { rows: [{ table_name: 'tasks', column_name: 'path_manifest' }] };
        }
        if (sql.includes('pg_indexes')) return { rows: [{ indexname: 'tasks_status_idx' }] };
        if (sql.includes('table_constraints')) {
          return { rows: [{ table_name: 'tasks', constraint_name: 'tasks_pkey' }] };
        }
        return { rows: [] };
      },
    };

    const shape = await readDbShape(session);
    expect([...shape.tables]).toEqual(['tasks']);
    expect([...shape.columns]).toEqual(['tasks.path_manifest']);
    expect([...shape.indexes]).toEqual(['tasks_status_idx']);
    expect([...shape.constraints]).toEqual(['tasks.tasks_pkey']);
  });
});

describe('recordApplied', () => {
  it('binds hash and created_at as parameters', async () => {
    const { session, queries } = capturingSession();
    await recordApplied(session, { hash: 'abc', folderMillis: 1787625829839, sql: [] });

    expect(queries[0]!.sql.replace(/\s+/g, ' ')).toContain(
      'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)'
    );
    expect(queries[0]!.params).toEqual(['abc', 1787625829839]);
  });
});

describe('tracking table: drizzle v1 shape', () => {
  const flat = (q: { sql: string }) => q.sql.replace(/\s+/g, ' ');

  it('a fresh table is created in the v1 shape (name, applied_at), so no upgrade is ever needed on it', async () => {
    const { session, queries } = capturingSession();
    await ensureTrackingTable(session);
    const create = flat(queries.find((q) => q.sql.includes('CREATE TABLE'))!);
    expect(create).toContain('"drizzle"."__drizzle_migrations"');
    expect(create).toContain('name text');
    expect(create).toContain('applied_at timestamptz DEFAULT now()');
    // IF NOT EXISTS: on an existing (old-shape) table this must change nothing,
    // because it runs before the pre-baseline guard.
    expect(create).toContain('CREATE TABLE IF NOT EXISTS');
  });

  it('readTrackingRows reads name when the column exists', async () => {
    const { session, queries } = capturingSession((sql) =>
      sql.includes('information_schema.columns')
        ? [{ column_name: 'id' }, { column_name: 'hash' }, { column_name: 'created_at' }, { column_name: 'name' }]
        : [{ name: 'x', hash: 'h', created_at: '1' }]
    );
    expect(await readTrackingRows(session)).toEqual([{ name: 'x', hash: 'h', created_at: '1' }]);
    expect(flat(queries.at(-1)!)).toContain('SELECT name, hash, created_at FROM "drizzle"."__drizzle_migrations"');
  });

  it('readTrackingRows reads an old-shape table without touching it (name reads as NULL)', async () => {
    const { session, queries } = capturingSession((sql) =>
      sql.includes('information_schema.columns') ? [{ column_name: 'hash' }, { column_name: 'created_at' }] : []
    );
    await readTrackingRows(session);
    expect(flat(queries.at(-1)!)).toContain('SELECT NULL::text AS name, hash, created_at');
    expect(queries.some((q) => /ALTER|UPDATE|INSERT/.test(q.sql))).toBe(false);
  });

  it('upgradeTrackingTable adds the columns additively and names legacy rows by exact created_at, NULL names only', async () => {
    const { session, queries } = capturingSession((sql) =>
      sql.includes('information_schema.columns') ? [{ column_name: 'hash' }, { column_name: 'created_at' }] : []
    );
    await upgradeTrackingTable(session, [
      { when: 1700000000123, name: '20231114221320_one' },
      { when: 1700000001456, name: '20231114221321_two' },
    ]);
    const all = queries.map(flat);
    expect(all.some((s) => s.includes('ADD COLUMN IF NOT EXISTS name text'))).toBe(true);
    expect(all.some((s) => s.includes('ADD COLUMN IF NOT EXISTS applied_at timestamptz'))).toBe(true);
    // Never DROP/ALTER TYPE anything: the old migrator must keep working (rollback).
    expect(all.some((s) => /DROP|ALTER COLUMN (?!applied_at SET DEFAULT)/.test(s))).toBe(false);
    const update = queries.find((q) => q.sql.startsWith('UPDATE'))!;
    expect(flat(update)).toContain('WHERE t.created_at = v.created_at AND t.name IS NULL');
    // Values are bound, not interpolated.
    expect(update.params).toEqual([1700000000123, '20231114221320_one', 1700000001456, '20231114221321_two']);
  });

  it('a second upgrade on an upgraded table with nothing to name executes nothing but the column probe', async () => {
    const { session, queries } = capturingSession((sql) =>
      sql.includes('information_schema.columns')
        ? [{ column_name: 'hash' }, { column_name: 'created_at' }, { column_name: 'name' }, { column_name: 'applied_at' }]
        : []
    );
    await upgradeTrackingTable(session, []);
    expect(queries.length).toBe(1);
    expect(queries[0]!.sql).toContain('information_schema.columns');
  });

  it('recordApplied with a name writes name and applied_at (the v1 row)', async () => {
    const { session, queries } = capturingSession();
    await recordApplied(session, { name: '20260101000000_x', hash: 'abc', folderMillis: 1767225600000, sql: [] });
    expect(flat(queries[0]!)).toContain(
      'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at, name, applied_at) VALUES ($1, $2, $3, now())'
    );
    expect(queries[0]!.params).toEqual(['abc', 1767225600000, '20260101000000_x']);
  });

  it('trackingInsert renders the same row recordApplied writes (it goes inside the atomic batch)', () => {
    const m = { name: '20260101000000_x', hash: 'abc', folderMillis: 1767225600000, sql: [] };
    const rendered = dialect.sqlToQuery(trackingInsert(m));
    expect(rendered.sql.replace(/\s+/g, ' ')).toContain('(hash, created_at, name, applied_at)');
    expect(rendered.params).toEqual(['abc', 1767225600000, '20260101000000_x']);
  });
});

describe('createIfNotExists', () => {
  // Two deploys migrating an empty database at once: both pass IF NOT EXISTS,
  // one CREATE loses on the catalog's unique index (test:db case H).
  const duplicate = Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('duplicate key value violates unique constraint "pg_type_typname_nsp_index"'), { code: '23505' }),
  });

  it('retries once when a concurrent session created the object first', async () => {
    let calls = 0;
    const session: MigrateSession = {
      async execute() {
        calls++;
        if (calls === 1) throw duplicate;
        return { rows: [] };
      },
    };
    await createIfNotExists(session, sql`CREATE TABLE IF NOT EXISTS x (id int)`);
    expect(calls).toBe(2);
  });

  it('does not swallow any other error, or a second duplicate', async () => {
    const other: MigrateSession = { execute: async () => Promise.reject(Object.assign(new Error('no'), { code: '42501' })) };
    await expect(createIfNotExists(other, sql`CREATE TABLE IF NOT EXISTS x (id int)`)).rejects.toThrow('no');
    const always: MigrateSession = { execute: async () => Promise.reject(duplicate) };
    await expect(createIfNotExists(always, sql`CREATE TABLE IF NOT EXISTS x (id int)`)).rejects.toBe(duplicate);
  });
});

describe('db/migrate.ts wiring', () => {
  // Source-text guards. The behaviour they protect is unit-tested elsewhere
  // (migrate-backfill.test.ts, migrate-lock.test.ts), but migrate.ts itself
  // cannot be imported — it calls main() and connects on import — so this is
  // what stops the two fixed bugs from being re-introduced by an edit here.
  const source = readFileSync(join(import.meta.dir, '..', 'db', 'migrate.ts'), 'utf8');

  it('writes tracking rows only through recordApplied / backfillTrackingRows', () => {
    // The C9 bug was a hand-rolled INSERT in the backfill loop that never looked
    // at migration.sql. Report the offending lines, not the whole file.
    const rawInserts = source
      .split('\n')
      .map((line, i) => `${i + 1}: ${line.trim()}`)
      .filter((line) => line.includes('INSERT INTO ${sql.identifier'));

    expect(
      rawInserts,
      'db/migrate.ts builds a tracking-row INSERT directly. Go through recordApplied() ' +
        'so every write is in one place, and through backfillTrackingRows() so a row is ' +
        'never written for a migration whose DDL was never observed.',
    ).toEqual([]);
    expect(source.includes('backfillTrackingRows(')).toBe(true);
    expect(source.includes('recordApplied(')).toBe(true);
  });

  it('runs the apply loop inside the migration lock', () => {
    const lockAt = source.indexOf('withMigrationLock(');
    const applyAt = source.indexOf('applyMigrationsV1(session, runBatch)');
    expect(
      lockAt >= 0 && applyAt > lockAt,
      'db/migrate.ts no longer runs applyMigrationsV1() inside withMigrationLock(). ' +
        'Two concurrent deploys would race the migrator again (finding C11).',
    ).toBe(true);
  });
});
