/**
 * database.query: the db half (rules: capability-database-query.ts).
 *
 * The executor connects as the dedicated read-only role in
 * BUILDD_QUERY_DATABASE_URL and nothing else: no env var, no executor, and the
 * broker refuses with `query_role_unconfigured`. Each statement runs in its own
 * non-interactive READ ONLY transaction (neon-http's `transaction`, no
 * interactive logic) behind SET LOCAL statement and lock timeouts.
 */
import 'server-only';
import { neon } from '@neondatabase/serverless';
import { Table, getTableName, is } from 'drizzle-orm';
import * as schema from '@buildd/core/db/schema';
import { findDatabaseQueryGrant } from './capability-grants-store';
import {
  DATABASE_QUERY_LIMITS,
  QueryExecutionError,
  type DatabaseQueryDeps,
  type ExecuteResult,
  type QueryAuditRow,
  type QueryParam,
} from './capability-database-query';

/** Every table the schema defines; the broker refuses any of them not on its allowlist by name. */
export function schemaTableNames(mod: Record<string, unknown> = schema as Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const v of Object.values(mod)) if (is(v, Table)) out.add(getTableName(v));
  return [...out].sort();
}

type NeonFull = ReturnType<typeof neon<false, true>>;

/** Run one wrapped statement read-only. Null when no read-only role is configured. */
export function readOnlyQueryExecutor(
  url: string | undefined = process.env.BUILDD_QUERY_DATABASE_URL,
  make: (url: string) => NeonFull = u => neon<false, true>(u, { fullResults: true }),
): DatabaseQueryDeps['execute'] {
  if (!url) return null;
  const sql = make(url);
  return async (text: string, params: QueryParam[]): Promise<ExecuteResult> => {
    try {
      const results = await sql.transaction([
        sql.query(`SET LOCAL statement_timeout = ${DATABASE_QUERY_LIMITS.statementTimeoutMs}`),
        sql.query(`SET LOCAL lock_timeout = ${DATABASE_QUERY_LIMITS.lockTimeoutMs}`),
        sql.query(text, params),
      ], { readOnly: true, fullResults: true });
      const last = results[results.length - 1];
      return { rows: last.rows as Record<string, unknown>[], fields: last.fields.map(f => f.name) };
    } catch (err) {
      const e = err as { message?: string; code?: string };
      throw new QueryExecutionError(e.message ?? 'query failed', typeof e.code === 'string' ? e.code : null);
    }
  };
}

let tableNames: string[] | null = null;

export function defaultDatabaseQueryDeps(audit: (row: QueryAuditRow) => void): DatabaseQueryDeps {
  tableNames ??= schemaTableNames();
  return {
    findGrant: p => findDatabaseQueryGrant(p),
    execute: readOnlyQueryExecutor(),
    knownTables: tableNames,
    audit,
  };
}
