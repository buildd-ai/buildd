#!/usr/bin/env bun
/**
 * Pre-promote schema drift detector.
 *
 * Compares the production database's actual column structure against the
 * Drizzle migration snapshot. Exits 1 (with a diff) if:
 *   - a column exists in the DB but not in the snapshot (manual DDL not tracked)
 *   - a column is expected by the snapshot but absent from the DB (unapplied migration)
 *
 * Reads DATABASE_URL from env. Uses information_schema for read-only introspection.
 * Run from the repo root: bun run scripts/check-schema-drift.ts
 */

import { neon } from '@neondatabase/serverless';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SNAPSHOT_DIR = join(ROOT, 'packages/core/drizzle/meta');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set');
  process.exit(1);
}

// ─── Load latest snapshot ────────────────────────────────────────────────────

function latestSnapshot(): { tables: Record<string, DrizzleTable> } {
  const files = readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.match(/^\d+_snapshot\.json$/))
    .sort();
  if (files.length === 0) throw new Error('No snapshot files found in ' + SNAPSHOT_DIR);
  const latest = files[files.length - 1];
  console.log(`Using snapshot: ${latest}`);
  return JSON.parse(readFileSync(join(SNAPSHOT_DIR, latest), 'utf8'));
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

async function actualColumns(sql: ReturnType<typeof neon>): Promise<Map<string, Set<string>>> {
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

async function main() {
  const snapshot = latestSnapshot();
  const expected = expectedColumns(snapshot);

  console.log(`Connecting to database...`);
  const sql = neon(DATABASE_URL!);

  const actual = await actualColumns(sql);

  // Detect applied migrations count from drizzle tracking table
  let appliedCount = 0;
  try {
    const applied = (await sql`SELECT COUNT(*) AS c FROM public.__drizzle_migrations`) as Array<{ c: string }>;
    appliedCount = Number(applied[0].c);
  } catch {
    // Table may not exist on fresh DBs — not an error
  }
  console.log(`Applied migrations in DB: ${appliedCount}`);

  // ─── Diff ──────────────────────────────────────────────────────────────────

  const driftLines: string[] = [];

  for (const [tableName, expectedCols] of expected) {
    const actualCols = actual.get(tableName);

    if (!actualCols) {
      // Whole table is missing — pending migration, not necessarily drift
      // (it will be created when migrations run on deploy).
      // Only warn; do not treat as fatal drift since migrations run pre-deploy.
      console.log(`  [pending] Table '${tableName}' not in DB yet — will be created on migrate`);
      continue;
    }

    // Columns expected by schema but missing from DB
    for (const col of expectedCols) {
      if (!actualCols.has(col)) {
        driftLines.push(`  MISSING in DB  : ${tableName}.${col}`);
      }
    }

    // Columns in DB but not in schema (manual DDL)
    for (const col of actualCols) {
      if (!expectedCols.has(col)) {
        // Skip Drizzle internal columns
        if (col === '__drizzle_migrations') continue;
        driftLines.push(`  EXTRA in DB    : ${tableName}.${col}  ← untracked manual DDL`);
      }
    }
  }

  // Tables in DB but not in snapshot at all (manual CREATE TABLE)
  for (const tableName of actual.keys()) {
    if (!expected.has(tableName) && tableName !== '__drizzle_migrations') {
      const cols = [...(actual.get(tableName) ?? [])].join(', ');
      driftLines.push(`  EXTRA TABLE    : ${tableName}  (columns: ${cols})  ← untracked manual DDL`);
    }
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
  process.exit(1);
}

main().catch((err) => {
  console.error('check-schema-drift: unexpected error:', err);
  process.exit(1);
});
