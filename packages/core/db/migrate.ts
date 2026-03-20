import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import { config } from '../config';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, '..', 'drizzle');

async function main() {
  console.log('Running migrations from:', migrationsFolder);

  // Retry loop to handle Neon preview branch endpoints that need time to start up.
  // New branch endpoints can return "password authentication failed" for up to a few minutes
  // while the compute is initializing and roles are being synced.
  // If all retries fail with auth errors, verify NEON_DB_USER / NEON_DB_PASSWORD secrets.
  const maxAttempts = 24;
  const retryDelayMs = 10000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Re-create connection each attempt in case the endpoint became ready
      const sql = neon(config.databaseUrl);
      const db = drizzle(sql);
      await migrate(db, { migrationsFolder });
      console.log('Migrations complete!');
      process.exit(0);
    } catch (err: any) {
      const msg: string = err?.message || String(err);
      const isTransient =
        msg.includes('password authentication failed') ||
        msg.includes('endpoint is disabled') ||
        msg.includes('connect ECONNREFUSED') ||
        msg.includes('ENOTFOUND');

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
