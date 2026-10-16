/**
 * The migrator's driver contract on real Postgres (packages/core/db/
 * migrate-client.ts). The unit test __tests__/migrate-driver-contract.test.ts
 * pins the same properties against a fake neon client; this proves them end to
 * end, through the real neon-http driver and the app's own `db`, on a database
 * the migrator has just migrated.
 *
 * Written against drizzle 0.45 and kept version-agnostic on purpose: these are
 * the properties a drizzle bump must not break.
 */
import { describe, it, expect } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  lockDriver,
  queryRows,
  readAppliedRows,
  readDbShape,
  type MigrateSession,
} from '@buildd/core/db/migrate-client';
import { assertDbConfigured } from './harness';

assertDbConfigured();

const session: MigrateSession = db;
const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

describe('migrator driver contract (real Postgres)', () => {
  it('reads the tracking table as object rows with integer created_at', async () => {
    const rows = await readAppliedRows(session);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // bigint comes back as a string over neon-http; planMigrations Number()s it.
      expect(Number.isInteger(Number(row.created_at))).toBe(true);
    }
  });

  it('introspects the live schema', async () => {
    const shape = await readDbShape(session);
    expect(shape.tables.has('tasks')).toBe(true);
    expect(shape.columns.has('tasks.id')).toBe(true);
  });

  it('the lock row admits one holder at a time and releases only its own', async () => {
    const lock = lockDriver(session);
    const a = `contract-a-${suffix}`;
    const b = `contract-b-${suffix}`;
    await lock.ensureTable();
    expect(await lock.tryAcquire(a, 15 * 60_000)).toBe(true);
    try {
      expect(await lock.tryAcquire(b, 15 * 60_000)).toBe(false);
      await lock.release(b); // not b's lock: a no-op
      expect((await lock.describeHolder())?.holder).toBe(a);
    } finally {
      await lock.release(a);
    }
    expect(await lock.describeHolder()).toBeNull();
  });

  it('db.batch is atomic: a failing statement rolls back the ones before it', async () => {
    // What a per-file apply (statements + tracking insert in one batch) will
    // rely on: no half-applied file is left behind without its row.
    const table = `migrator_batch_probe_${suffix}`;
    await expect(
      db.batch([
        db.execute(sql.raw(`CREATE TABLE ${table} (id int)`)),
        db.execute(sql.raw(`INSERT INTO ${table}_missing VALUES (1)`)),
      ])
    ).rejects.toThrow();
    const rows = await queryRows<{ n: number }>(
      session,
      sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = ${table}`
    );
    expect(rows[0]?.n).toBe(0);
  });
});
