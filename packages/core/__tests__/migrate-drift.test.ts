import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyExtraSchemaObjects,
  classifyMissingSchemaObjects,
  loadMigrationSources,
  loadSnapshotMetas,
  reconcileAppliedCount,
  resolveSnapshotSelection,
  type MigrationSource,
  type SnapshotMeta,
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
    // The skip moved out of an inline loop and into the shared extra-object
    // classifier, so assert the WIRING (the set still reaches the classifier)
    // rather than a literal comparison that no longer exists. The skip itself is
    // covered behaviourally by classifyExtraSchemaObjects' own test below.
    expect(script).toContain('ignoredTables: MIGRATOR_OWNED_TABLES');
  });

  it('hands the extra-object path the applied set, so it can trace a creator', () => {
    // Guard for the forked-chain false positive: the extra-object path used to
    // assert "untracked manual DDL" without ever consulting which migration
    // created the object or whether that migration had been applied. Dropping
    // appliedWhens here would silently restore that.
    const call = /classifyExtraSchemaObjects\(\{[\s\S]*?\}\);/.exec(script)?.[0] ?? '';
    expect(call).toContain('sources');
    expect(call).toContain('appliedWhens');
  });

  it('resolves the snapshot through the chain, not by filename sort', () => {
    // The original selection was `readdirSync(...).sort()` and took the last
    // entry, which silently picks one arbitrary sibling when the chain forks.
    expect(script).toContain('resolveSnapshotSelection');
    expect(script).not.toMatch(/readdirSync\(SNAPSHOT_DIR\)/);
  });

  it('refuses to emit a drift verdict when it cannot verify, using a distinct exit code', () => {
    expect(script).toContain('EXIT_CANNOT_VERIFY');
    // A fork must not exit with the drift code — that is what conflated a repo
    // metadata problem with a hand-edited production database.
    const forkBlock = /if \(selection\.kind === 'forked'\)[\s\S]*?\n  \}/.exec(script)?.[0] ?? '';
    expect(forkBlock).toContain('process.exit(EXIT_CANNOT_VERIFY)');
    expect(forkBlock).not.toContain('EXIT_DRIFT');
  });
});

/**
 * Guard for the forked-snapshot-chain class of false positive.
 *
 * Drizzle snapshots form a linked list: each carries its own `id` and the
 * `prevId` of the snapshot it was generated from. Two concurrent `db:generate`
 * runs each diff against the same parent, each take the next free index, and git
 * conflicts on neither the .sql nor the .json — so the chain silently forks into
 * siblings that each hold only half of the schema.
 *
 * The gate used to select a snapshot by filename alone. When it picked the
 * sibling that branched off before a table was added, that legitimately-migrated
 * table read as `← untracked manual DDL` — a production-emergency phrasing for a
 * repo metadata problem. Worse, the two causes demand opposite responses and the
 * output could not distinguish them.
 *
 * So: a fork at the selected tip now REFUSES to produce a verdict, and an extra
 * object is traced to its creating migration before it can be called manual DDL.
 */

function meta(file: string, id: string, prevId: string): SnapshotMeta {
  return { file, id, prevId };
}

describe('resolveSnapshotSelection', () => {
  it('resolves the chain tip on a linear chain', () => {
    const result = resolveSnapshotSelection([
      meta('0000_snapshot.json', 'a', ''),
      meta('0001_snapshot.json', 'b', 'a'),
      meta('0002_snapshot.json', 'c', 'b'),
    ]);

    expect(result.kind).toBe('resolved');
    expect(result.file).toBe('0002_snapshot.json');
    expect(result.siblings).toEqual([]);
  });

  it('REFUSES to resolve when the selected tip has a sibling claiming the same parent', () => {
    // The live shape: 0156 and 0157 both generated from 0155.
    const result = resolveSnapshotSelection([
      meta('0155_snapshot.json', 'p', 'o'),
      meta('0156_snapshot.json', 'x', 'p'),
      meta('0157_snapshot.json', 'y', 'p'),
    ]);

    expect(result.kind).toBe('forked');
    expect(result.file).toBe('0157_snapshot.json');
    expect(result.siblings).toEqual(['0156_snapshot.json']);
    expect(result.prevId).toBe('p');
  });

  it('names every sibling when more than two runs forked off one parent', () => {
    const result = resolveSnapshotSelection([
      meta('0010_snapshot.json', 'p', 'o'),
      meta('0011_snapshot.json', 'x', 'p'),
      meta('0012_snapshot.json', 'y', 'p'),
      meta('0013_snapshot.json', 'z', 'p'),
    ]);

    expect(result.kind).toBe('forked');
    expect(result.siblings).toEqual(['0011_snapshot.json', '0012_snapshot.json']);
  });

  it('still resolves when an OLDER fragment dangles — that is healed residue, not a live fork', () => {
    // 0067/0069-class residue: a snapshot whose successor was removed by past
    // renumbering leaves a dangling tip. It must not block a release.
    const result = resolveSnapshotSelection([
      meta('0000_snapshot.json', 'a', ''),
      meta('0001_snapshot.json', 'b', 'a'),
      meta('0003_snapshot.json', 'd', 'deleted-0002'),
      meta('0004_snapshot.json', 'e', 'd'),
    ]);

    expect(result.kind).toBe('resolved');
    expect(result.file).toBe('0004_snapshot.json');
  });

  it('does not mistake two independent roots for a fork of the tip', () => {
    const result = resolveSnapshotSelection([
      meta('0000_snapshot.json', 'a', ''),
      meta('0001_snapshot.json', 'b', ''),
      meta('0002_snapshot.json', 'c', 'b'),
    ]);

    expect(result.kind).toBe('resolved');
    expect(result.file).toBe('0002_snapshot.json');
  });

  it('orders by numeric index, not by string length', () => {
    const result = resolveSnapshotSelection([
      meta('9_snapshot.json', 'a', ''),
      meta('10_snapshot.json', 'b', 'a'),
    ]);

    expect(result.file).toBe('10_snapshot.json');
  });

  it('reports having nothing to resolve rather than throwing', () => {
    expect(resolveSnapshotSelection([]).kind).toBe('empty');
  });

  it("resolves THIS repo's own snapshot chain — a live fork must fail the suite, not the release", () => {
    const metas = loadSnapshotMetas(join(import.meta.dir, '..', 'drizzle', 'meta'));
    expect(metas.length).toBeGreaterThan(100);

    const result = resolveSnapshotSelection(metas);
    if (result.kind === 'forked') {
      throw new Error(
        `Snapshot chain is forked: ${result.file} and ${result.siblings.join(', ')} ` +
          `all claim prevId ${result.prevId}. Relinearize before releasing.`
      );
    }
    expect(result.kind).toBe('resolved');
  });
});

describe('classifyExtraSchemaObjects', () => {
  const specTable = 'CREATE TABLE "spec_discrepancies" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"workspace_id" uuid NOT NULL\n);';

  it('calls an extra table created by an APPLIED journal migration a SNAPSHOT GAP, not manual DDL', () => {
    // The live shape: the table is in the DB because its migration ran, and
    // absent from the snapshot only because the chosen snapshot predates it.
    const result = classifyExtraSchemaObjects({
      sources: [source('0156_empty_speed', 2_000, [specTable])],
      appliedWhens: new Set([2_000]),
      expected: new Map([['tasks', new Set(['id'])]]),
      actual: new Map([
        ['tasks', new Set(['id'])],
        ['spec_discrepancies', new Set(['id', 'workspace_id'])],
      ]),
      droppedTables: new Set(),
      droppedColumns: new Set(),
      ignoredTables: new Set(),
    });

    expect(result.snapshotGap).toEqual([
      'spec_discrepancies — created by 0156_empty_speed, which __drizzle_migrations records as APPLIED',
    ]);
    expect(result.manualDdl).toEqual([]);
  });

  it('reports an extra table that NO migration creates as manual DDL — the real emergency', () => {
    const result = classifyExtraSchemaObjects({
      sources: [source('0001_init', 1_000, ['CREATE TABLE "tasks" (\n\t"id" uuid PRIMARY KEY NOT NULL\n);'])],
      appliedWhens: new Set([1_000]),
      expected: new Map([['tasks', new Set(['id'])]]),
      actual: new Map([
        ['tasks', new Set(['id'])],
        ['hand_made', new Set(['id'])],
      ]),
      droppedTables: new Set(),
      droppedColumns: new Set(),
      ignoredTables: new Set(),
    });

    expect(result.manualDdl).toEqual(['hand_made — no migration in the journal creates it']);
    expect(result.snapshotGap).toEqual([]);
  });

  it('treats an extra table a migration DROPS as a pending drop', () => {
    const result = classifyExtraSchemaObjects({
      sources: [],
      appliedWhens: new Set(),
      expected: new Map(),
      actual: new Map([['going_away', new Set(['id'])]]),
      droppedTables: new Set(['going_away']),
      droppedColumns: new Set(),
      ignoredTables: new Set(),
    });

    expect(result.pendingDrop).toEqual(['going_away']);
    expect(result.manualDdl).toEqual([]);
  });

  it('applies the same creator tracing to an extra COLUMN — the symmetric half of the fork', () => {
    // Had the gate picked the other sibling, worker_heartbeats.runner_commit
    // would have been the extra object instead of the table.
    const result = classifyExtraSchemaObjects({
      sources: [
        source('0157_noisy_marauders', 3_000, [
          'ALTER TABLE "worker_heartbeats" ADD COLUMN "runner_commit" text;',
        ]),
      ],
      appliedWhens: new Set([3_000]),
      expected: new Map([['worker_heartbeats', new Set(['id'])]]),
      actual: new Map([['worker_heartbeats', new Set(['id', 'runner_commit'])]]),
      droppedTables: new Set(),
      droppedColumns: new Set(),
      ignoredTables: new Set(),
    });

    expect(result.snapshotGap).toEqual([
      'worker_heartbeats.runner_commit — created by 0157_noisy_marauders, which __drizzle_migrations records as APPLIED',
    ]);
    expect(result.manualDdl).toEqual([]);
  });

  it('reports an extra column no migration adds as manual DDL', () => {
    const result = classifyExtraSchemaObjects({
      sources: [],
      appliedWhens: new Set(),
      expected: new Map([['tasks', new Set(['id'])]]),
      actual: new Map([['tasks', new Set(['id', 'hand_added'])]]),
      droppedTables: new Set(),
      droppedColumns: new Set(),
      ignoredTables: new Set(),
    });

    expect(result.manualDdl).toEqual(['tasks.hand_added — no migration in the journal creates it']);
  });

  it('honours a pending column drop', () => {
    const result = classifyExtraSchemaObjects({
      sources: [],
      appliedWhens: new Set(),
      expected: new Map([['tasks', new Set(['id'])]]),
      actual: new Map([['tasks', new Set(['id', 'going_away'])]]),
      droppedTables: new Set(),
      droppedColumns: new Set(['tasks.going_away']),
      ignoredTables: new Set(),
    });

    expect(result.pendingDrop).toEqual(['tasks.going_away']);
    expect(result.manualDdl).toEqual([]);
  });

  it('separates an extra table whose creating migration has NOT been applied yet', () => {
    const result = classifyExtraSchemaObjects({
      sources: [source('0156_empty_speed', 2_000, [specTable])],
      appliedWhens: new Set(),
      expected: new Map(),
      actual: new Map([['spec_discrepancies', new Set(['id', 'workspace_id'])]]),
      droppedTables: new Set(),
      droppedColumns: new Set(),
      ignoredTables: new Set(),
    });

    expect(result.notYetApplied).toEqual([
      'spec_discrepancies — created by 0156_empty_speed (not yet applied)',
    ]);
    expect(result.manualDdl).toEqual([]);
  });

  it('ignores migrator-owned tables', () => {
    const result = classifyExtraSchemaObjects({
      sources: [],
      appliedWhens: new Set(),
      expected: new Map(),
      actual: new Map([['__drizzle_migrations', new Set(['id'])]]),
      droppedTables: new Set(),
      droppedColumns: new Set(),
      ignoredTables: new Set(['__drizzle_migrations']),
    });

    expect(result.manualDdl).toEqual([]);
    expect(result.snapshotGap).toEqual([]);
  });

  it('says nothing at all when the DB carries no extra objects', () => {
    const result = classifyExtraSchemaObjects({
      sources: [],
      appliedWhens: new Set(),
      expected: new Map([['tasks', new Set(['id'])]]),
      actual: new Map([['tasks', new Set(['id'])]]),
      droppedTables: new Set(),
      droppedColumns: new Set(),
      ignoredTables: new Set(),
    });

    expect(result).toEqual({
      snapshotGap: [],
      pendingDrop: [],
      manualDdl: [],
      notYetApplied: [],
    });
  });
});

describe('reconcileAppliedCount', () => {
  it('explains a tracking-table total that exceeds the journal instead of just printing both', () => {
    // The live shape: 202 applied rows against a 158-entry journal, which read
    // as alarming and was in fact fully accounted for.
    const result = reconcileAppliedCount({
      sources: [source('a', 100, []), source('b', 200, []), source('c', 300, [])],
      appliedWhens: new Set([100, 200, 50, 60]),
    });

    expect(result).toEqual({
      journalEntries: 3,
      appliedTotal: 4,
      appliedFromJournal: 2,
      pending: 1,
      historicalOutsideRef: 2,
      reconciles: true,
    });
  });

  it('reconciles exactly when every applied row is a journal entry', () => {
    const result = reconcileAppliedCount({
      sources: [source('a', 100, []), source('b', 200, [])],
      appliedWhens: new Set([100, 200]),
    });

    expect(result.historicalOutsideRef).toBe(0);
    expect(result.pending).toBe(0);
    expect(result.reconciles).toBe(true);
  });
});

describe('build.yml migration check does not trust db:generate exit code', () => {
  /**
   * drizzle-kit prints `Error: [...] are pointing to a parent snapshot [...]
   * which is a collision.` when the snapshot chain forks — and exits 0. A failed
   * generate also writes nothing, which is indistinguishable from "no changes
   * needed" to a `git status --porcelain drizzle/` check. So the step reported
   * success while `bun db:generate` was completely non-functional on the branch.
   *
   * Source-text guard: a workflow cannot be invoked from a unit test.
   */
  const workflow = readFileSync(
    join(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'build.yml'),
    'utf8'
  );

  it('asserts on db:generate output, because a failed generate still exits 0', () => {
    const step = /- name: Check migrations are up to date[\s\S]*?\n      - name: /.exec(workflow)?.[0];
    expect(step, 'the "Check migrations are up to date" step went missing').toBeDefined();
    expect(step).toContain('bun db:generate');
    expect(
      step,
      'The step must fail on an error in db:generate output. Relying on the exit ' +
        'code or on `git status --porcelain drizzle/` alone lets a broken generate ' +
        'report success, because a generate that fails writes nothing.'
    ).toMatch(/grep -qE .\^Error:/);
  });
});
