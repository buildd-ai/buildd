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

const DRIZZLE = join(import.meta.dir, '../../../../packages/core/drizzle');

/** drizzle v1 snapshots are v8: a flat `ddl[]` of entities, columns among them. */
type SnapshotColumn = { entityType: string; name: string; table: string; schema?: string; notNull?: boolean };

function latestSnapshotColumns(): SnapshotColumn[] {
  const tip = readdirSync(DRIZZLE).filter((f) => /^\d{14}_/.test(f)).sort().at(-1)!;
  const snapshot = JSON.parse(readFileSync(join(DRIZZLE, tip, 'snapshot.json'), 'utf8')) as { ddl: SnapshotColumn[] };
  return snapshot.ddl.filter((e) => e.entityType === 'columns');
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
  const expected = latestSnapshotColumns()
    .filter((c) => (c.schema || 'public') === 'public')
    .map((c) => ({ key: `${c.table}.${c.name}`, notNull: !!c.notNull }));

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
