import 'server-only';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon, NeonQueryFunction } from '@neondatabase/serverless';
import * as schema from './schema';
import { config } from '../config';
import { applyNeonLocalOverride } from './neon-local';
import { capturePostgresErrorOnSpan } from './error-span';
import { wrapNeonQuery } from './query-wrapper';
import { assertTestDatabaseSafe } from './test-guard';

// Lazy initialization to avoid errors during build
let _sql: NeonQueryFunction<false, false> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getSql() {
  if (!_sql) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is required');
    }
    // A unit test must never reach a real database (see ./test-guard).
    assertTestDatabaseSafe(config.databaseUrl);
    // Opt-in local Postgres via a Neon HTTP proxy (scripts/demo). No-op unless
    // NEON_LOCAL_FETCH_ENDPOINT is set; throws if DATABASE_URL is not loopback.
    applyNeonLocalOverride({ ...process.env, DATABASE_URL: config.databaseUrl });
    const baseSql = neon(config.databaseUrl);
    // Capture DB errors on the active span without forcing the lazy query to
    // run early — see query-wrapper.ts for why that broke every db.batch.
    wrapNeonQuery(baseSql, capturePostgresErrorOnSpan);
    _sql = baseSql;
  }
  return _sql;
}

// When DISABLE_WRITES=true (set in visual-QA CI against the prod-clone Neon branch),
// block insert/update/delete so the ephemeral app never mutates prod-shaped data.
const DISABLE_WRITES = process.env.DISABLE_WRITES === 'true';
const WRITE_OPS = new Set(['insert', 'update', 'delete']);

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    if (DISABLE_WRITES && typeof prop === 'string' && WRITE_OPS.has(prop)) {
      throw new Error(`[DISABLE_WRITES] Mutation blocked: db.${prop}() called in read-only mode`);
    }
    if (!_db) {
      _db = drizzle(getSql(), { schema });
    }
    return (_db as any)[prop];
  },
});
