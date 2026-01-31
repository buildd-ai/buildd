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

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    if (!_db) {
      _db = drizzle(getSql(), { schema });
    }
    return (_db as any)[prop];
  },
});
