import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema.js';
import { config } from '../config.js';

const sql = neon(config.databaseUrl);
export const db = drizzle(sql, { schema });
