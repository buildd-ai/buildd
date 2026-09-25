/**
 * Drizzle client for a LOCAL Postgres behind a Neon HTTP proxy — for tooling
 * that runs outside Next (scripts/demo seed/advance). Same driver and schema as
 * db/client.ts, but it refuses to exist unless the override is active, so it can
 * never be pointed at a hosted database.
 */
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema';
import { applyNeonLocalOverride } from './neon-local';

export function createLocalDb(env: Record<string, string | undefined> = process.env) {
  if (!applyNeonLocalOverride(env)) {
    throw new Error('[local-client] NEON_LOCAL_FETCH_ENDPOINT is required (loopback only)');
  }
  return drizzle(neon(env.DATABASE_URL!), { schema });
}

export type LocalDb = ReturnType<typeof createLocalDb>;
export { schema };
// Re-exported so tooling outside this package needn't resolve drizzle-orm itself.
export { sql, eq, and, inArray } from 'drizzle-orm';
