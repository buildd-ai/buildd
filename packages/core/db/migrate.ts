import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql } from 'drizzle-orm';
import { config } from '../config';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { planMigrations } from './migrate-plan';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, '..', 'drizzle');

const SCHEMA = 'drizzle';
const TABLE = '__drizzle_migrations';

async function main() {
  console.log('Running migrations from:', migrationsFolder);

  // Retry loop for Neon preview branch cold starts. The CI now extracts
  // the connection URI directly from the Neon API, so "password authentication
  // failed" should be rare. Retries mainly cover ECONNREFUSED / endpoint-disabled.
  const maxAttempts = 24;
  const retryDelayMs = 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const neonSql = neon(config.databaseUrl);
      const db = drizzle(neonSql);

      // Ensure tracking schema + table exist
      await db.session.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(SCHEMA)}`);
      await db.session.execute(sql`
        CREATE TABLE IF NOT EXISTS ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);

      // Fetch ALL applied migration timestamps (not just the last).
      const rows = await db.session.all(
        sql`SELECT created_at FROM ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)}`
      );
      const migrations = readMigrationFiles({ migrationsFolder });

      // A missing tracking row does NOT mean a migration never ran — it can
      // mean it ran but the tracking insert was lost (the exact bug this file
      // was rewritten to fix). Only migrations newer than the high-water mark
      // are safe to execute blind; anything older with a missing row is
      // backfilled instead of replayed. See migrate-plan.ts.
      const { toRun, toBackfill } = planMigrations(
        migrations,
        rows as { created_at: string | number }[]
      );

      for (const migration of toBackfill) {
        console.log(`Backfilling tracking row for already-applied migration: ${migration.folderMillis}`);
        await db.session.execute(
          sql`INSERT INTO ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (hash, created_at)
              VALUES (${migration.hash}, ${migration.folderMillis})`
        );
      }

      for (const migration of toRun) {
        for (const stmt of migration.sql) {
          await db.session.execute(sql.raw(stmt));
        }

        // Record immediately so a later failure doesn't force a re-run.
        await db.session.execute(
          sql`INSERT INTO ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (hash, created_at)
              VALUES (${migration.hash}, ${migration.folderMillis})`
        );

        console.log(`Applied: ${migration.folderMillis}`);
      }

      console.log(`Migrations complete! (${toRun.length} applied, ${toBackfill.length} backfilled)`);
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
