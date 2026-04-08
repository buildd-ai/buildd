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

  // Retry loop for Neon preview branch cold starts. The CI now extracts
  // the connection URI directly from the Neon API, so "password authentication
  // failed" should be rare. Retries mainly cover ECONNREFUSED / endpoint-disabled.
  const maxAttempts = 12;
  const retryDelayMs = 5000;

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
