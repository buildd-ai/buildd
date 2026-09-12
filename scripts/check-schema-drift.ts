#!/usr/bin/env bun
/**
 * Pre-promote schema drift detector.
 *
 * Compares the production database's actual column structure against the
 * Drizzle migration snapshot. Exits 1 (with a diff) if:
 *   - a column/table exists in the DB but not in the snapshot, and no migration
 *     drops it (untracked manual DDL)
 *   - a column/table the snapshot expects is absent from the DB AND the
 *     migration that adds it is already recorded in `__drizzle_migrations`
 *     (a migration that "ran" without its DDL taking effect — the 0067-class
 *     silent skip, or a tracking row backfilled without the DDL)
 *   - a column/table the snapshot expects is absent from the DB and NO migration
 *     in the journal adds it
 *
 * It does NOT fail for a column whose migration has not been recorded yet:
 * migrations run during the deploy, i.e. after this gate. Those are reported as
 * `[pending]` with a count. Classification lives in
 * packages/core/db/migrate-drift.ts, which keeps this file thin enough to stay a
 * top-to-bottom script while the decisions it makes are unit-tested.
 *
 * Reads DATABASE_URL from env. Uses information_schema for read-only introspection.
 * Run from the repo root: bun run scripts/check-schema-drift.ts
 *   --offline   skip the database entirely and report only what can be measured
 *               from the repo (snapshot + journal). Useful for verifying this
 *               script runs at all without touching a real database.
 *
 * Exit codes: 0 pass, 1 drift, 2 could not verify (forked snapshot chain, or no
 * usable DATABASE_URL). 2 never implicates production — see
 * docs/design/migration-doctrine.md Rule 7.
 */

import { neon } from '@neondatabase/serverless';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  classifyExtraSchemaObjects,
  classifyMissingSchemaObjects,
  loadMigrationSources,
  loadSnapshotMetas,
  reconcileAppliedCount,
  resolveSnapshotSelection,
} from '../packages/core/db/migrate-drift';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SNAPSHOT_DIR = join(ROOT, 'packages/core/drizzle/meta');
const MIGRATIONS_DIR = join(ROOT, 'packages/core/drizzle');

const OFFLINE = process.argv.includes('--offline');

// `neon(url)` returns NeonQueryFunction<false, false>, which is narrower than the
// generic defaults in `ReturnType<typeof neon>` — spell the instantiation out so
// passing the client to a helper type-checks.
type NeonClient = ReturnType<typeof neon<false, false>>;

// Tables drizzle/this repo's migrator own. They are created by raw DDL in
// packages/core/db/migrate.ts rather than by schema.ts, so they are never in the
// snapshot and must not be reported as untracked manual DDL. Both normally live
// in the `drizzle` schema (which this script does not introspect); the check
// stays because a legacy `public.__drizzle_migrations` exists on older databases.
const MIGRATOR_OWNED_TABLES = new Set(['__drizzle_migrations', '__buildd_migrate_lock']);

// Exit codes are distinct on purpose. 1 means "I compared the DB to the schema
// and they diverge". 2 means "I could not make a trustworthy comparison at all",
// which is a repo problem, not a production one. Conflating them is how a
// metadata fork came to be reported as a hand-edited production database.
const EXIT_DRIFT = 1;
const EXIT_CANNOT_VERIFY = 2;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL && !OFFLINE) {
  console.error('ERROR: DATABASE_URL is not set');
  process.exit(EXIT_CANNOT_VERIFY);
}

// neon() throws a raw stack trace on invalid URLs — validate format up front
// so a misconfigured secret produces an actionable message instead.
if (DATABASE_URL) {
  try {
    new URL(DATABASE_URL);
  } catch {
    console.error('ERROR: DATABASE_URL is not a valid URL — check the DATABASE_URL secret value in repo settings');
    process.exit(EXIT_CANNOT_VERIFY);
  }
}

// ─── Pending drops ──────────────────────────────────────────────────────────
//
// Migrations run during the deploy, i.e. AFTER this gate (Rule 2 of the
// migration doctrine). A column the DB still has, which a migration drops, is
// therefore expected rather than manual DDL. Additive pending migrations were
// already tolerated below; removals were not, which made any DROP COLUMN
// impossible to release.
//
// This deliberately scans EVERY migration rather than trying to work out which
// are pending: drizzle's __drizzle_migrations row count and the journal length
// have diverged in this repo, so index arithmetic against the applied count is
// not reliable. It does not need to be. This is only ever consulted for a
// column that is absent from the latest snapshot but present in the DB. If
// some migration drops it, then either it already ran -- in which case the
// column would be gone -- or it has not run yet. A column later re-added
// appears in the latest snapshot, so it never reaches this path.
//
// Returns the sets of "table.column" and "table" that some migration drops.
function droppedByMigration(): { columns: Set<string>; tables: Set<string> } {
  const columns = new Set<string>();
  const tables = new Set<string>();
  const migrationDir = join(SNAPSHOT_DIR, '..');
  let files: string[];
  try {
    files = readdirSync(migrationDir).filter((f) => f.endsWith('.sql'));
  } catch {
    console.log('  [warn] could not read migration dir — pending drops not considered');
    return { columns, tables };
  }
  const columnRe = /ALTER\s+TABLE\s+"?(\w+)"?\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi;
  const tableRe = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi;
  for (const f of files) {
    let sqlText: string;
    try {
      sqlText = readFileSync(join(migrationDir, f), 'utf8');
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    while ((m = columnRe.exec(sqlText)) !== null) columns.add(`${m[1]}.${m[2]}`);
    while ((m = tableRe.exec(sqlText)) !== null) tables.add(m[1]!);
  }
  return { columns, tables };
}

// ─── Load latest snapshot ────────────────────────────────────────────────────

function latestSnapshot(): { tables: Record<string, DrizzleTable> } {
  const metas = loadSnapshotMetas(SNAPSHOT_DIR);
  const selection = resolveSnapshotSelection(metas);

  if (selection.kind === 'empty') {
    throw new Error('No snapshot files found in ' + SNAPSHOT_DIR);
  }

  if (selection.kind === 'forked') {
    console.error('\n\u26d4 Cannot verify: the Drizzle snapshot chain is FORKED.\n');
    console.error(`  ${selection.file} and ${selection.siblings.join(', ')}`);
    console.error(`  all record prevId ${selection.prevId} \u2014 they are siblings, not a sequence.\n`);
    console.error(`Two concurrent 'bun db:generate' runs each diffed against the same parent and
each claimed the next free index. Git conflicts on neither the .sql nor the
.json, so the fork lands silently, and each sibling holds only part of the
schema.

NO DRIFT VERDICT IS POSSIBLE in this state. Whichever sibling this gate picked,
whatever the other one added would read as an object the snapshot has never
heard of \u2014 indistinguishable from production having been hand-edited. Only one
of those is an emergency, so the gate refuses to guess.

This is a repo metadata problem. Production has not been inspected and is not
implicated. To resolve, relinearize the chain: rebuild the highest-numbered
snapshot as a true child of its sibling (its sibling's content plus its own
delta, keeping its own id, with prevId set to the sibling's id).

Do NOT delete the snapshot and re-run db:generate \u2014 that re-derives migrations
production has already applied. The .sql files are correct and already applied;
only the snapshot metadata is inconsistent.`);
    process.exit(EXIT_CANNOT_VERIFY);
  }

  console.log(`Using snapshot: ${selection.file} (chain tip of ${metas.length} snapshots)`);

  // Older fragments dangle in this repo as residue from past renumbering, which
  // has been harmless for a long time \u2014 surfaced, never fatal, because failing
  // on it would block every release to re-litigate settled history.
  const tips = metas.filter(
    (m) => m.id && !metas.some((other) => other.prevId === m.id) && m.file !== selection.file
  );
  if (tips.length > 0) {
    console.log(
      `  [note] ${tips.length} older snapshot(s) dangle (successor removed by past ` +
        `renumbering): ${tips.map((t) => t.file).join(', ')} \u2014 not release-blocking`
    );
  }

  return JSON.parse(readFileSync(join(SNAPSHOT_DIR, selection.file), 'utf8'));
}

interface DrizzleColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

interface DrizzleTable {
  name: string;
  schema: string;
  columns: Record<string, DrizzleColumn>;
}

// ─── Build expected column set from snapshot ─────────────────────────────────

function expectedColumns(snapshot: ReturnType<typeof latestSnapshot>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const tableKey of Object.keys(snapshot.tables)) {
    const table = snapshot.tables[tableKey];
    const tableName = table.name;
    const cols = new Set<string>();
    for (const col of Object.values(table.columns)) {
      cols.add(col.name);
    }
    result.set(tableName, cols);
  }
  return result;
}

// ─── Query actual columns from DB ────────────────────────────────────────────

async function actualColumns(sql: NeonClient): Promise<Map<string, Set<string>>> {
  const rows = (await sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name
  `) as Array<{ table_name: string; column_name: string }>;
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    const { table_name, column_name } = row;
    if (!result.has(table_name)) result.set(table_name, new Set());
    result.get(table_name)!.add(column_name);
  }
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Every `created_at` recorded in the tracking table. drizzle-kit creates the
 * table in the "drizzle" schema by default (not "public") unless
 * migrationsSchema is set in drizzle.config.ts — querying
 * public.__drizzle_migrations always throws and would silently report zero
 * applied migrations, which looks identical to "no migrations ever ran" even
 * against a long-lived production DB. Check both to avoid that false signal.
 */
async function appliedWhens(sql: NeonClient): Promise<Set<number> | null> {
  const toSet = (rows: Array<{ created_at: string | number }>) =>
    new Set(rows.map((r) => Number(r.created_at)));
  try {
    return toSet(
      (await sql`SELECT created_at FROM drizzle.__drizzle_migrations`) as Array<{
        created_at: string | number;
      }>
    );
  } catch {
    // Fall through to the legacy location.
  }
  try {
    return toSet(
      (await sql`SELECT created_at FROM public.__drizzle_migrations`) as Array<{
        created_at: string | number;
      }>
    );
  } catch {
    // Table exists in neither schema (fresh DB). Distinct from "zero rows".
    return null;
  }
}

async function main() {
  const snapshot = latestSnapshot();
  const expected = expectedColumns(snapshot);
  const sources = loadMigrationSources(MIGRATIONS_DIR);
  console.log(
    `Snapshot expects ${expected.size} tables; journal has ${sources.length} migrations`
  );

  if (OFFLINE) {
    const offline = classifyMissingSchemaObjects({
      sources,
      appliedWhens: new Set(),
      expected,
      actual: expected, // nothing missing by construction
    });
    console.log(
      `--offline: ${offline.measured.expectedObjects} snapshot objects, ` +
        `${offline.measured.expectedWithoutCreator} of them not traceable to any ` +
        `creating migration (journal creates ${offline.measured.addedByMigrations} objects in total)`
    );
    console.log('--offline: skipped the database; no drift verdict produced.');
    process.exit(0);
  }

  console.log(`Connecting to database...`);
  const sql = neon(DATABASE_URL!);

  const actual = await actualColumns(sql);
  const applied = await appliedWhens(sql);
  if (applied === null) {
    console.log('Applied migrations in DB: tracking table absent');
  } else {
    // Print the arithmetic, not two bare numbers. The journal is only what this
    // ref carries; the tracking table is append-only apply history, so it
    // legitimately holds rows for migrations that were renumbered or that
    // predate a rebuilt journal. Side by side those two counts invite the
    // inference that production is running migrations we do not know about.
    const counts = reconcileAppliedCount({ sources, appliedWhens: applied });
    console.log(
      `Applied migrations in DB: ${counts.appliedTotal} = ` +
        `${counts.appliedFromJournal} from this ref's journal + ` +
        `${counts.historicalOutsideRef} historical (renumbered, or predating a rebuilt journal)`
    );
    console.log(
      `  journal has ${counts.journalEntries} entries: ${counts.appliedFromJournal} applied, ` +
        `${counts.pending} pending (they run on deploy, after this gate)`
    );
  }

  const drops = droppedByMigration();

  // ─── Diff ──────────────────────────────────────────────────────────────────

  const driftLines: string[] = [];

  // Objects the snapshot expects that the DB does not have. Whether that is
  // benign depends entirely on whether the migration adding them is already
  // recorded as applied — see packages/core/db/migrate-drift.ts.
  const missing = classifyMissingSchemaObjects({
    sources,
    appliedWhens: applied ?? new Set(),
    expected,
    actual,
  });
  console.log(
    `Missing-object scan: ${missing.measured.missing} of ${missing.measured.expectedObjects} ` +
      `snapshot objects absent from the DB — ${missing.drift.length} drift, ` +
      `${missing.pending.length} pending, ${missing.unexplained.length} unexplained ` +
      `(${missing.measured.expectedWithoutCreator} snapshot objects have no traceable creator)`
  );
  for (const line of missing.pending) {
    console.log(`  [pending] ${line} — will be created on migrate`);
  }
  for (const line of missing.drift) {
    driftLines.push(`  MISSING in DB  : ${line}`);
  }
  for (const line of missing.unexplained) {
    driftLines.push(`  MISSING in DB  : ${line}`);
  }

  // Objects the DB has that the snapshot does not. Symmetrically with the
  // missing-object scan above, an extra object is traced to its creating
  // migration BEFORE it can be called manual DDL: a table created by a
  // migration the tracking table records as applied is tracked and applied, and
  // its absence from the snapshot is a snapshot-coverage gap. Asserting
  // "untracked manual DDL" there reads as a hand-edited production database and
  // sends the reader after entirely the wrong cause.
  const extra = classifyExtraSchemaObjects({
    sources,
    appliedWhens: applied ?? new Set(),
    expected,
    actual,
    droppedTables: drops.tables,
    droppedColumns: drops.columns,
    ignoredTables: MIGRATOR_OWNED_TABLES,
  });
  for (const target of extra.pendingDrop) {
    console.log(`  [pending] '${target}' still in DB — will be dropped on migrate`);
  }
  for (const line of extra.notYetApplied) {
    console.log(`  [pending] ${line}`);
  }
  for (const line of extra.snapshotGap) {
    // Not drift: the object is fully migrated and applied. The snapshot this
    // gate resolved simply does not cover it, which happens when a migration is
    // hand-added to the journal without a regenerated snapshot.
    console.log(`  [snapshot gap] ${line}`);
  }
  for (const line of extra.manualDdl) {
    driftLines.push(`  EXTRA in DB    : ${line}  ← untracked manual DDL`);
  }

  if (driftLines.length === 0) {
    console.log('\n✅ Schema drift check passed — DB matches Drizzle snapshot.');
    process.exit(0);
  }

  console.error('\n❌ Schema drift detected:\n');
  for (const line of driftLines) {
    console.error(line);
  }
  console.error(`
Drift means the production DB has been manually altered (DDL applied outside of
migrations) or a migration failed to apply. To resolve:

  1. If a column/table was added manually: create a migration file that adds it
     (cd packages/core && bun db:generate), commit it, and open a reconciliation
     PR (see docs/design/migration-doctrine.md Rule 3).

  2. If a column/table is missing from the DB: run migrations before promoting
     (cd packages/core && bun db:migrate).
`);
  process.exit(EXIT_DRIFT);
}

main().catch((err) => {
  console.error('check-schema-drift: unexpected error:', err);
  process.exit(EXIT_CANNOT_VERIFY);
});
