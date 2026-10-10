/**
 * A database migrated from zero has the columns the latest drizzle snapshot
 * describes, with the same nullability.
 *
 * Released databases were built migration by migration over months; CI's
 * integration job runs on a fork of one. Only fresh databases (this suite's,
 * demo, local Docker) run the baseline from scratch, so a baseline that
 * disagrees with schema.ts is invisible everywhere a released DB is used.
 * That happened: the baseline made task_schedules.workspace_id NOT NULL while
 * schema.ts has it nullable, and every team-level mission 500'd on its
 * check-in schedule on a fresh DB only. CI's db-architecture job migrates an
 * empty Postgres before this runs, so this compares exactly that DB.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';

const META = join(import.meta.dir, '../../../../packages/core/drizzle/meta');

type SnapshotColumn = { name: string; notNull?: boolean };
type Snapshot = { tables: Record<string, { name: string; schema?: string; columns: Record<string, SnapshotColumn> }> };

function latestSnapshot(): Snapshot {
  const files = readdirSync(META).filter((f) => /^\d+_snapshot\.json$/.test(f)).sort();
  return JSON.parse(readFileSync(join(META, files[files.length - 1]), 'utf8'));
}

let live: Map<string, boolean>;
beforeAll(async () => {
  assertDbConfigured();
  const rows = await q<{ table_name: string; column_name: string; is_nullable: string }>(sql`
    SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public'
  `);
  live = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable === 'NO']));
});

describe('migrated schema matches the latest snapshot', () => {
  const snapshot = latestSnapshot();
  const expected = Object.values(snapshot.tables)
    .filter((t) => (t.schema || 'public') === 'public')
    .flatMap((t) => Object.values(t.columns).map((c) => ({ key: `${t.name}.${c.name}`, notNull: !!c.notNull })));

  test('every snapshot column exists', () => {
    expect(expected.filter((c) => !live.has(c.key)).map((c) => c.key)).toEqual([]);
  });

  test('no column exists that the snapshot does not know', () => {
    const known = new Set(expected.map((c) => c.key));
    const extra = [...live.keys()].filter((k) => !known.has(k) && !k.startsWith('__drizzle_migrations.'));
    expect(extra).toEqual([]);
  });

  test('nullability matches for every column', () => {
    const mismatched = expected
      .filter((c) => live.has(c.key) && live.get(c.key) !== c.notNull)
      .map((c) => `${c.key}: snapshot notNull=${c.notNull}, db notNull=${live.get(c.key)}`);
    expect(mismatched).toEqual([]);
  });
});
