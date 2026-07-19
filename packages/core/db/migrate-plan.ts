// Pure planning logic for db/migrate.ts, split out so it's unit-testable without
// a live database connection.

export interface MigrationFile {
  hash: string;
  folderMillis: number;
  sql: string[];
}

export interface AppliedRow {
  created_at: string | number;
}

export interface MigrationPlan {
  /** Migrations whose SQL should actually be executed. */
  toRun: MigrationFile[];
  /**
   * Migrations with no tracking row that are NOT newer than the current
   * high-water mark. Their DDL predates the newest migration we know ran
   * successfully, so a missing row means "applied but never recorded" (e.g. a
   * dropped connection after DDL executed but before the tracking insert
   * landed) rather than "never applied". We backfill a tracking row instead
   * of re-executing — replaying old DDL against a schema that has since moved
   * on is not safe in general (columns/tables it references may have been
   * renamed or dropped by a later migration).
   */
  toBackfill: MigrationFile[];
}

/**
 * Decide which migrations to execute vs. backfill-only.
 *
 * Never treat "no tracking row" as sufficient evidence that a migration was
 * never applied — only migrations strictly newer than the current
 * high-water mark are safe to execute blind, because nothing since the last
 * known-applied migration could have changed the schema out from under them.
 */
export function planMigrations(migrations: MigrationFile[], appliedRows: AppliedRow[]): MigrationPlan {
  const appliedMillis = appliedRows.map((r) => Number(r.created_at));
  const applied = new Set(appliedMillis);
  const highWaterMark = appliedMillis.length > 0 ? Math.max(...appliedMillis) : 0;

  const toRun: MigrationFile[] = [];
  const toBackfill: MigrationFile[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.folderMillis)) continue;
    if (migration.folderMillis <= highWaterMark) {
      toBackfill.push(migration);
    } else {
      toRun.push(migration);
    }
  }

  return { toRun, toBackfill };
}
