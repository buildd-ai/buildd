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

// ─── Squashed baseline ───────────────────────────────────────────────────────
//
// Every migration released up to the squash was condensed into one file,
// drizzle/0000_baseline.sql: a schema dump of a fresh database migrated through
// that whole history. Its journal entry carries `"baseline": true` and the
// `when` of the last migration it absorbed, so a database that already ran that
// migration holds the tracking row and skips it, exactly like any applied
// migration.
//
// It is only safe to execute on an EMPTY tracking table. A database that
// stopped partway through the absorbed history already holds some of what the
// dump creates: running it would fail on the first existing object, after
// having created everything before it. Such a database has to finish the old
// history first, with a release that still ships it.

/**
 * The newest release whose migration tree still carries the individual
 * migrations the baseline absorbed (its last migration is the cut point). A
 * database must reach it before it can upgrade past the squash.
 */
export const LAST_RELEASE_BEFORE_SQUASH = 'v0.284.0';

export class PreBaselineDatabaseError extends Error {
  constructor(highWaterMark: number, baselineMillis: number) {
    super(
      `This database stopped partway through the migration history that was squashed into ` +
        `drizzle/0000_baseline.sql: its newest applied migration (created_at ${highWaterMark}) is older ` +
        `than the baseline's cut point (${baselineMillis}). Running the baseline here would collide with ` +
        `the objects it already has. Upgrade it first with release ${LAST_RELEASE_BEFORE_SQUASH} ` +
        `(\`git checkout ${LAST_RELEASE_BEFORE_SQUASH} && cd packages/core && bun db:migrate\`), ` +
        `then run this release's migrations. Do NOT hand-insert tracking rows.`
    );
    this.name = 'PreBaselineDatabaseError';
  }
}

export interface JournalLike {
  entries: ReadonlyArray<{ idx: number; when: number; tag: string; baseline?: boolean }>;
}

/** The `when` of the journal's baseline entry, or undefined for an unsquashed tree. */
export function findBaselineMillis(journal: JournalLike): number | undefined {
  const flagged = journal.entries.filter((e) => e.baseline === true);
  if (flagged.length === 0) return undefined;
  if (flagged.length > 1) {
    throw new Error(`Migration journal has ${flagged.length} baseline entries; there can be only one.`);
  }
  const first = [...journal.entries].sort((a, b) => a.idx - b.idx)[0]!;
  if (flagged[0] !== first) {
    throw new Error(
      `Migration journal flags ${flagged[0]!.tag} as the baseline, but a baseline must be the first entry.`
    );
  }
  return flagged[0]!.when;
}

export interface PlanOptions {
  /** `when` of the squashed baseline migration, if the tree has one. */
  baselineMillis?: number;
}

/**
 * Decide which migrations to execute vs. backfill-only.
 *
 * Never treat "no tracking row" as sufficient evidence that a migration was
 * never applied — only migrations strictly newer than the current
 * high-water mark are safe to execute blind, because nothing since the last
 * known-applied migration could have changed the schema out from under them.
 *
 * The baseline is the one exception to the backfill rule: it is never a
 * backfill candidate. It runs on a fresh database, is skipped on one at or past
 * its cut point, and anything in between throws PreBaselineDatabaseError.
 */
export function planMigrations(
  migrations: MigrationFile[],
  appliedRows: AppliedRow[],
  options: PlanOptions = {}
): MigrationPlan {
  const appliedMillis = appliedRows.map((r) => Number(r.created_at));
  const applied = new Set(appliedMillis);
  const highWaterMark = appliedMillis.length > 0 ? Math.max(...appliedMillis) : 0;
  const { baselineMillis } = options;

  let pending = migrations;
  const toRun: MigrationFile[] = [];

  if (baselineMillis !== undefined) {
    const [first, ...rest] = migrations;
    if (!first || first.folderMillis !== baselineMillis) {
      throw new Error(`The squashed baseline (${baselineMillis}) must be the first migration in the tree.`);
    }
    pending = rest;
    if (appliedMillis.length === 0) {
      toRun.push(first);
    } else if (highWaterMark < baselineMillis) {
      throw new PreBaselineDatabaseError(highWaterMark, baselineMillis);
    }
    // Otherwise the database is at or past the cut point: the baseline's DDL is
    // there, whether or not its own row survived. Skip it either way.
  }

  const toBackfill: MigrationFile[] = [];
  for (const migration of pending) {
    if (applied.has(migration.folderMillis)) continue;
    if (migration.folderMillis <= highWaterMark) {
      toBackfill.push(migration);
    } else {
      toRun.push(migration);
    }
  }

  return { toRun, toBackfill };
}
