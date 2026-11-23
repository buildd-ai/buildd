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
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { reconstructSchemaDdl } from '@buildd/core/db/snapshot-reconstruct';
import { assertDbConfigured, q } from './harness';

const DRIZZLE = join(import.meta.dir, '../../../../packages/core/drizzle');

/** An entity of the reconstructed `ddl[]`; columns among them. */
type SnapshotColumn = { entityType: string; name: string; table: string; schema?: string; notNull?: boolean };

/**
 * The schema the migrations folder describes. From drizzle-kit 1.0.0-rc.6
 * (snapshot format 10) only the first snapshot holds it, the rest hold deltas,
 * so drizzle-kit replays them; parallel leaves are reconstructed each and unioned.
 */
async function latestSnapshotColumns(): Promise<SnapshotColumn[]> {
  const { snapshot } = await reconstructSchemaDdl(DRIZZLE);
  return (snapshot.ddl as SnapshotColumn[]).filter((e) => e.entityType === 'columns');
}
const snapshotColumns = await latestSnapshotColumns();

let live: Map<string, boolean>;
beforeAll(async () => {
  assertDbConfigured();
  const rows = await q<{ table_name: string; column_name: string; is_nullable: string }>(sql`
    SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public'
  `);
  live = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable === 'NO']));
});

describe('migrated schema matches the latest snapshot', () => {
  const expected = snapshotColumns
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
