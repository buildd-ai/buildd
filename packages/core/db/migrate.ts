import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql } from 'drizzle-orm';
import { config } from '../config';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

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
      // The built-in Drizzle migrator only looks at the most recent entry,
      // which means a failed migration N can prevent N-1's tracking row from
      // being recorded. We record after each migration instead.
      const rows = await db.session.all(
        sql`SELECT created_at FROM ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)}`
      );
      const applied = new Set((rows as { created_at: string | number }[]).map((r) => Number(r.created_at)));

      const migrations = readMigrationFiles({ migrationsFolder });
      let ran = 0;

      for (const migration of migrations) {
        if (applied.has(migration.folderMillis)) continue;

        for (const stmt of migration.sql) {
          await db.session.execute(sql.raw(stmt));
        }

        // Record immediately so a later failure doesn't force a re-run.
        await db.session.execute(
          sql`INSERT INTO ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (hash, created_at)
              VALUES (${migration.hash}, ${migration.folderMillis})`
        );

        applied.add(migration.folderMillis);
        ran++;
        console.log(`Applied: ${migration.folderMillis}`);
      }

      console.log(`Migrations complete! (${ran} applied)`);
      process.exit(0);
    } catch (err: any) {
      const msg: string = err?.message || String(err);
      const isTransient =
        msg.includes('endpoint is disabled') ||
        msg.includes('connect ECONNREFUSED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('password authentication failed');

      if (isTransient && attempt < maxAttempts) {
        console.log(`Attempt ${attempt}/${maxAttempts} failed (${msg}), retrying in ${retryDelayMs / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      } else {
        console.error('Migration failed:', msg);
        process.exit(1);
      }
    }
  }
}

main();
