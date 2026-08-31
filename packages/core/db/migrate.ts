import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql } from 'drizzle-orm';
import { hostname } from 'os';
import { config } from '../config';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { planMigrations } from './migrate-plan';
import { backfillTrackingRows } from './migrate-backfill';
import { withMigrationLock } from './migrate-lock';
import {
  ensureTrackingTable,
  lockDriver,
  readAppliedRows,
  readDbShape,
  recordApplied,
  type MigrateSession,
} from './migrate-client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, '..', 'drizzle');

async function applyMigrations(session: MigrateSession): Promise<void> {
  // Fetch ALL applied migration timestamps (not just the last). This read now
  // happens INSIDE the migration lock — two concurrent deploys used to both read
  // before either wrote, compute the same `toRun`, and race each other through
  // it.
  const rows = await readAppliedRows(session);
  const migrations = readMigrationFiles({ migrationsFolder });

  // A missing tracking row does NOT mean a migration never ran — it can mean it
  // ran but the tracking insert was lost. Only migrations newer than the
  // high-water mark are safe to execute blind; anything older with a missing row
  // is a backfill CANDIDATE, and must prove its DDL is already present before a
  // tracking row is written. See migrate-plan.ts and migrate-backfill.ts.
  const { toRun, toBackfill } = planMigrations(migrations, rows);

  let backfilled = 0;
  if (toBackfill.length > 0) {
    console.log(
      `${toBackfill.length} untracked migration(s) predate the high-water mark — ` +
        `introspecting the live schema to check whether their DDL is already applied...`
    );
    const shape = await readDbShape(session);
    console.log(
      `  live schema: ${shape.tables.size} tables, ${shape.columns.size} columns, ` +
        `${shape.indexes.size} indexes, ${shape.constraints.size} constraints`
    );
    const result = await backfillTrackingRows({
      toBackfill,
      shape,
      allowUnverified: process.env.MIGRATION_BACKFILL_ALLOW_UNVERIFIED === '1',
      log: (message) => console.log(message),
      record: (migration) => recordApplied(session, migration),
    });
    backfilled = result.recorded;
    if (result.unverified > 0) {
      console.log(
        `  ${result.unverified} migration(s) were recorded WITHOUT DDL evidence via ` +
          `MIGRATION_BACKFILL_ALLOW_UNVERIFIED=1`
      );
    }
  }

  for (const migration of toRun) {
    for (const stmt of migration.sql) {
      await session.execute(sql.raw(stmt));
    }

    // Record only after every statement in the file succeeded. A failure above
    // leaves no row, so the next run retries rather than believing a
    // half-applied migration finished.
    await recordApplied(session, migration);

    console.log(`Applied: ${migration.folderMillis} (${migration.sql.length} statement(s))`);
  }

  console.log(`Migrations complete! (${toRun.length} applied, ${backfilled} backfilled)`);
}

async function main() {
  console.log('Running migrations from:', migrationsFolder);

  // Retry loop for Neon preview branch cold starts. The CI now extracts
  // the connection URI directly from the Neon API, so "password authentication
  // failed" should be rare. Retries mainly cover ECONNREFUSED / endpoint-disabled.
  const maxAttempts = 24;
  const retryDelayMs = 5000;

  const holder = `${hostname()}/pid${process.pid}/${Math.random().toString(36).slice(2, 8)}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const neonSql = neon(config.databaseUrl);
      const db = drizzle(neonSql);
      // `session` is not in drizzle's public typings, but it is the only handle
      // that takes a raw SQL template on the neon-http driver.
      const session = (db as unknown as { session: MigrateSession }).session;

      await ensureTrackingTable(session);

      // Serialise concurrent deploys. `pg_advisory_lock` is not available on
      // this driver (see migrate-lock.ts); this is a lock row taken by one
      // atomic statement. The loser waits and then finds nothing to do.
      await withMigrationLock(lockDriver(session), { holder, log: (m) => console.log(m) }, () =>
        applyMigrations(session)
      );

      process.exit(0);
    } catch (err: any) {
      const msg: string = err?.message || String(err);
      // neon-http query errors often carry the real Postgres detail on nested
      // properties rather than in `message` — surface everything we can so a
      // failure like this doesn't show a bare query with no cause again.
      const detail = [err?.cause?.message, err?.detail, err?.hint, err?.position]
        .filter(Boolean)
        .join(' | ');
      const isTransient =
        msg.includes('endpoint is disabled') ||
        msg.includes('connect ECONNREFUSED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('password authentication failed');

      if (isTransient && attempt < maxAttempts) {
        console.log(`Attempt ${attempt}/${maxAttempts} failed (${msg}), retrying in ${retryDelayMs / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      } else {
        console.error('Migration failed:', msg, detail ? `| ${detail}` : '');
        process.exit(1);
      }
    }
  }
}

main();
