import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool } from '@neondatabase/serverless';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { config } from '../config';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import ws from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, '..', 'drizzle');

async function main() {
  // Use Pool (WebSocket) for migrations - supports multi-statement SQL
  const pool = new Pool({ connectionString: config.databaseUrl, webSocketConstructor: ws });
  const db = drizzle(pool);

  console.log('Running migrations from:', migrationsFolder);
  await migrate(db, { migrationsFolder });
  console.log('Migrations complete!');
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err?.message || err);
  process.exit(1);
});
