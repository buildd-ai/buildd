import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyMissingSchemaObjects,
  loadMigrationSources,
  type MigrationSource,
} from '../db/migrate-drift';

/**
 * Guard for finding C32b: `scripts/check-schema-drift.ts` printed `[pending]`
 * for every column the snapshot expects but the DB lacks, then exited 0 — while
 * docs/design/migration-doctrine.md claimed the gate "fails if any column is
 * expected by the snapshot but absent from the DB". The permissive behaviour is
 * right for a migration that has not run yet (migrations run on deploy, after
 * this gate) and wrong for one the tracking table already claims is applied:
 * that is either the 0067-class silent skip or a bogus backfill (finding C9),
 * and both are exactly what this gate exists to catch.
 *
 * So the missing objects are now CLASSIFIED, not lumped together.
 */

function source(tag: string, when: number, statements: string[]): MigrationSource {
  return { tag, when, statements };
}

const expected = new Map([['tasks', new Set(['id', 'path_manifest'])]]);

describe('classifyMissingSchemaObjects', () => {
  it('flags a missing column whose migration is already recorded as applied as DRIFT', () => {
    const result = classifyMissingSchemaObjects({
      sources: [source('0067_tasks_path_manifest', 1_000, ['ALTER TABLE "tasks" ADD COLUMN "path_manifest" jsonb;'])],
      appliedWhens: new Set([1_000]),
      expected,
      actual: new Map([['tasks', new Set(['id'])]]),
    });

    expect(result.drift).toEqual([
      'tasks.path_manifest — added by 0067_tasks_path_manifest, which __drizzle_migrations records as APPLIED',
    ]);
    expect(result.pending).toEqual([]);
  });

  it('treats a missing column from an unapplied migration as PENDING', () => {
    const result = classifyMissingSchemaObjects({
      sources: [source('0067_tasks_path_manifest', 1_000, ['ALTER TABLE "tasks" ADD COLUMN "path_manifest" jsonb;'])],
      appliedWhens: new Set(),
      expected,
      actual: new Map([['tasks', new Set(['id'])]]),
    });

    expect(result.drift).toEqual([]);
    expect(result.pending).toEqual(['tasks.path_manifest — added by 0067_tasks_path_manifest (not yet applied)']);
  });

  it('reports a missing column that no migration adds as UNEXPLAINED', () => {
    const result = classifyMissingSchemaObjects({
      sources: [],
      appliedWhens: new Set(),
      expected,
      actual: new Map([['tasks', new Set(['id'])]]),
    });

    expect(result.unexplained).toEqual(['tasks.path_manifest — no migration in the journal adds it']);
  });

  it('flags a missing whole table the same way when its CREATE TABLE is recorded applied', () => {
    const result = classifyMissingSchemaObjects({
      sources: [source('0001_missions', 500, ['CREATE TABLE IF NOT EXISTS "missions" (\n"id" text\n);'])],
      appliedWhens: new Set([500]),
      expected: new Map([['missions', new Set(['id'])]]),
      actual: new Map(),
    });

    expect(result.drift.join(' ')).toContain('missions');
    expect(result.drift.join(' ')).toContain('APPLIED');
  });

  it('says nothing when the DB matches the snapshot', () => {
    const result = classifyMissingSchemaObjects({
      sources: [source('0067', 1_000, ['ALTER TABLE "tasks" ADD COLUMN "path_manifest" jsonb;'])],
      appliedWhens: new Set([1_000]),
      expected,
      actual: new Map([['tasks', new Set(['id', 'path_manifest'])]]),
    });

    expect(result.drift).toEqual([]);
    expect(result.pending).toEqual([]);
    expect(result.unexplained).toEqual([]);
    expect(result.measured.missing).toBe(0);
  });

  it('counts what it measured so an empty comparison cannot look like a pass', () => {
    const result = classifyMissingSchemaObjects({
      sources: [source('0067', 1_000, ['ALTER TABLE "tasks" ADD COLUMN "path_manifest" jsonb;'])],
      appliedWhens: new Set([1_000]),
      expected,
      actual: new Map([['tasks', new Set(['id'])]]),
    });

    expect(result.measured).toEqual({
      expectedObjects: 3, // table `tasks` + 2 columns
      missing: 1,
      addedByMigrations: 1,
      appliedMigrations: 1,
      // `tasks` itself and `tasks.id` are not created by the single ADD COLUMN
      // migration in this fixture.
      expectedWithoutCreator: 2,
    });
  });
});

describe('loadMigrationSources', () => {
  it('loads this repo\'s real journal with statements for every entry', () => {
    const sources = loadMigrationSources(new URL('../drizzle', import.meta.url).pathname);

    console.log(`loadMigrationSources: ${sources.length} migrations, ` +
      `${sources.reduce((n, s) => n + s.statements.length, 0)} statements`);

    expect(sources.length).toBeGreaterThan(100);
    // Every entry must carry SQL: a journal entry whose file failed to read
    // would silently make its columns look "unexplained" instead of drifted.
    // (The only all-comments file in the repo, 0024_numerous_firebird.sql, is an
    // orphan the journal never references, so it is not loaded here at all.)
    expect(sources.filter((s) => s.statements.length === 0).map((s) => s.tag)).toEqual([]);
    expect(sources.every((s) => Number.isFinite(s.when) && s.when > 0)).toBe(true);
  });

  it('classifies the real journal against a DB that is missing a real column', () => {
    // End-to-end over the actual corpus: pick the newest ADD COLUMN in the
    // journal, mark its migration applied, and remove the column from the
    // "database". The gate must call that drift, not pending.
    const sources = loadMigrationSources(new URL('../drizzle', import.meta.url).pathname);
    const withAdd = [...sources]
      .reverse()
      .find((s) => s.statements.some((st) => /ADD COLUMN/i.test(st)))!;
    const stmt = withAdd.statements.find((st) => /ADD COLUMN/i.test(st))!;
    const [, table, column] = /ALTER TABLE "?(\w+)"?\s+ADD COLUMN (?:IF NOT EXISTS )?"?(\w+)"?/i.exec(stmt)!;

    const result = classifyMissingSchemaObjects({
      sources,
      appliedWhens: new Set(sources.map((s) => s.when)),
      expected: new Map([[table!, new Set([column!])]]),
      actual: new Map([[table!, new Set()]]),
    });

    expect(result.drift.join(' ')).toContain(`${table}.${column}`);
    expect(result.drift.join(' ')).toContain('APPLIED');
  });
});

describe('real snapshot coverage', () => {
  /**
   * The `unexplained` bucket is fatal, so every object the CURRENT snapshot
   * expects must be traceable to the migration that creates it. If this drops
   * below 100%, the gate would fail a release for an object it simply could not
   * parse — the exact false-positive that makes people delete gates. It is also
   * a canary: a new migration written in a form the parser misses (a bare
   * multi-CREATE-TABLE file, a rename this does not follow) shows up here first.
   */
  it('traces every snapshot object to a creating migration', () => {
    const drizzleDir = new URL('../drizzle', import.meta.url).pathname;
    const sources = loadMigrationSources(drizzleDir);

    const metaDir = join(drizzleDir, 'meta');
    const snapshotFile = readdirSync(metaDir)
      .filter((f) => /^\d+_snapshot\.json$/.test(f))
      .sort()
      .pop()!;
    const snapshot = JSON.parse(readFileSync(join(metaDir, snapshotFile), 'utf8')) as {
      tables: Record<string, { name: string; columns: Record<string, { name: string }> }>;
    };

    const expectedFromSnapshot = new Map<string, Set<string>>();
    for (const table of Object.values(snapshot.tables)) {
      expectedFromSnapshot.set(
        table.name,
        new Set(Object.values(table.columns).map((c) => c.name))
      );
    }

    const result = classifyMissingSchemaObjects({
      sources,
      appliedWhens: new Set(),
      expected: expectedFromSnapshot,
      actual: expectedFromSnapshot, // nothing missing: this measures attribution only
    });

    console.log(
      `snapshot ${snapshotFile}: ${result.measured.expectedObjects} objects, ` +
        `${result.measured.expectedWithoutCreator} without a creating migration, ` +
        `${result.measured.addedByMigrations} objects created across ${sources.length} migrations`
    );

    expect(result.measured.expectedObjects).toBeGreaterThan(500);
    expect(
      result.measured.expectedWithoutCreator,
      'Some object in the latest snapshot cannot be traced to the migration that ' +
        'creates it, so scripts/check-schema-drift.ts would report it as ' +
        '"unexplained" (fatal) if it ever went missing from the DB. Extend ' +
        'createTableColumns / addedBy in migrate-drift.ts to understand the new form.',
    ).toBe(0);
  });
});

describe('check-schema-drift.ts internal-table skip', () => {
  /**
   * Finding C32c: the script carried
   *   `for (const col of actualCols) { if (col === '__drizzle_migrations') continue; ... }`
   * — a COLUMN name compared against a TABLE name, copied from the working
   * table-level test ~12 lines below it. It could never match, so it skipped
   * nothing. The intent (don't report the migrator's own tables as untracked
   * manual DDL) now lives in one table-level set, and the migration lock table
   * added for finding C11 is in it too.
   *
   * Source-text guard: the script self-exits on import, so it cannot be called.
   */
  const script = readFileSync(
    join(import.meta.dir, '..', '..', '..', 'scripts', 'check-schema-drift.ts'),
    'utf8'
  );

  it('has no column-vs-table-name comparison left', () => {
    const deadGuards = script
      .split('\n')
      .map((line, i) => `${i + 1}: ${line.trim()}`)
      .filter((line) => /\bcol\b\s*===\s*'__(drizzle_migrations|buildd_migrate_lock)'/.test(line));

    expect(
      deadGuards,
      'A column name is being compared to a table name again. Table-level skips ' +
        'belong in MIGRATOR_OWNED_TABLES.',
    ).toEqual([]);
  });

  it('skips the migrator-owned tables by table name', () => {
    expect(script).toContain('MIGRATOR_OWNED_TABLES');
    expect(script).toContain("'__drizzle_migrations'");
    expect(script).toContain("'__buildd_migrate_lock'");
    expect(script).toContain('!MIGRATOR_OWNED_TABLES.has(tableName)');
  });
});
