import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { lockDriver, readDbShape, recordApplied, type MigrateSession } from '../db/migrate-client';

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
    async execute(query: SQL) {
      const rendered = dialect.sqlToQuery(query);
      queries.push({ sql: rendered.sql, params: rendered.params });
      return undefined;
    },
    async all(query: SQL) {
      const rendered = dialect.sqlToQuery(query);
      queries.push({ sql: rendered.sql, params: rendered.params });
      return rowsFor(rendered.sql);
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
      async execute() {
        return undefined;
      },
      async all(query: SQL) {
        const sql = dialect.sqlToQuery(query).sql;
        if (sql.includes('information_schema.tables')) return [{ table_name: 'tasks' }];
        if (sql.includes('information_schema.columns')) {
          return [{ table_name: 'tasks', column_name: 'path_manifest' }];
        }
        if (sql.includes('pg_indexes')) return [{ indexname: 'tasks_status_idx' }];
        if (sql.includes('table_constraints')) {
          return [{ table_name: 'tasks', constraint_name: 'tasks_pkey' }];
        }
        return [];
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
    const applyAt = source.indexOf('applyMigrations(session)');
    expect(
      lockAt >= 0 && applyAt > lockAt,
      'db/migrate.ts no longer runs applyMigrations() inside withMigrationLock(). ' +
        'Two concurrent deploys would race the migrator again (finding C11).',
    ).toBe(true);
  });
});
