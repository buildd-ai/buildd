import 'server-only';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon, NeonQueryFunction } from '@neondatabase/serverless';
import * as schema from './schema';
import { config } from '../config';

// Lazy initialization to avoid errors during build
let _sql: NeonQueryFunction<false, false> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getSql() {
  if (!_sql) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is required');
    }
    _sql = neon(config.databaseUrl);
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
