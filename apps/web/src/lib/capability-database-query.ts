/**
 * database.query: a read of the team's production database through buildd's
 * broker, under a task-scoped grant. Pure; the db half is
 * capability-database-query-store.ts.
 *
 * An agent asks `request_capability { provider: 'neon', access: 'read' }`, a
 * person (or the team's Neon read policy) grants it, and the agent then calls
 * `query_database { sql }`. buildd never hands out a connection string: the
 * query runs server-side, and what it may do is enforced in three layers, each
 * of which would hold alone:
 *
 *   1. this module refuses anything that is not one SELECT over the allowlisted
 *      tables (`checkReadOnlySql`), before any connection is opened;
 *   2. the statement runs inside a READ ONLY transaction with a statement
 *      timeout, wrapped as a subquery under a row cap, so a write or a
 *      data-modifying CTE fails in Postgres itself;
 *   3. the connection is a dedicated login role (BUILDD_QUERY_DATABASE_URL)
 *      holding SELECT on the allowlisted tables and nothing else. With no such
 *      role configured the call refuses; it never falls back to the owner's
 *      DATABASE_URL.
 *
 * Every attempt is recorded on the task's access trail with the SQL text, the
 * row count and the duration. Result rows are never recorded.
 *
 * Spec: docs/specs/database-query-agent-capability.md
 */

export const DATABASE_QUERY_CAPABILITY = 'database.query';
/** The provider an agent names to ask for it. Neon is the first database:query provider. */
export const DATABASE_QUERY_PROVIDER = 'neon';
/** The role the query runs as; scripts/query-role-grants.ts prints its grants. */
export const DATABASE_QUERY_ROLE = 'buildd_query_ro';

/**
 * Tables a database.query grant reads: the delivery-forensics set (workflow
 * kernel, gates, missions, tasks, workers, outcome verdicts and the decision
 * ledgers). Anything else is refused by name here and by privilege in Postgres.
 */
export const DATABASE_QUERY_TABLES: readonly string[] = [
  'decision_outcomes',
  'decision_records',
  'gate_events',
  'missions',
  'orchestration_decisions',
  'spec_outcome_verdicts',
  'tasks',
  'workers',
  'workflow_attempts',
  'workflow_command_outbox',
  'workflow_commands',
  'workflow_deliveries',
  'workflow_effects',
  'workflow_facts',
  'workflow_findings',
  'workflow_mission_epochs',
  'workflow_review_rounds',
  'workflow_scope_amendments',
  'workflow_transitions',
];

export const DATABASE_QUERY_LIMITS = {
  maxSqlChars: 20_000,
  defaultRows: 200,
  maxRows: 1_000,
  maxParams: 20,
  statementTimeoutMs: 15_000,
  lockTimeoutMs: 2_000,
  /** SQL text kept on the access trail; longer text is cut and marked. */
  auditSqlChars: 4_000,
} as const;

// ── SQL check ────────────────────────────────────────────────────────────────

export type SqlRefusal =
  | 'empty' | 'too_long' | 'unterminated' | 'multiple_statements' | 'not_select'
  | 'write_keyword' | 'system_catalog' | 'function_not_allowed' | 'table_not_allowed';

interface Token { kind: 'word' | 'quoted' | 'string' | 'punct'; value: string }

/**
 * Split SQL into words, quoted identifiers, string literals and punctuation,
 * dropping comments. Strings (including E'' and dollar-quoted) become single
 * tokens so nothing inside one is mistaken for a keyword or a table.
 */
function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      if (depth > 0) return null;
      continue;
    }
    if (c === "'" || ((c === 'e' || c === 'E') && src[i + 1] === "'")) {
      const escapes = c !== "'";
      i += escapes ? 2 : 1;
      let closed = false;
      while (i < n) {
        if (escapes && src[i] === '\\') { i += 2; continue; }
        if (src[i] === "'") {
          if (src[i + 1] === "'") { i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return null;
      out.push({ kind: 'string', value: '' });
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (m) {
        const end = src.indexOf(m[0], i + m[0].length);
        if (end < 0) return null;
        i = end + m[0].length;
        out.push({ kind: 'string', value: '' });
        continue;
      }
      // $1 placeholder
      i++;
      while (i < n && /[0-9]/.test(src[i])) i++;
      continue;
    }
    if (c === '"') {
      let v = '';
      i++;
      let closed = false;
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') { v += '"'; i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        v += src[i++];
      }
      if (!closed) return null;
      out.push({ kind: 'quoted', value: v });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let v = '';
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) v += src[i++];
      out.push({ kind: 'word', value: v.toLowerCase() });
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[0-9.eE]/.test(src[i])) i++;
      continue;
    }
    out.push({ kind: 'punct', value: c });
    i++;
  }
  return out;
}

/**
 * Words that change data, schema, privileges or session state. A read-only
 * transaction already refuses most of them; refusing them here means the
 * agent gets a plain answer and nothing is sent.
 */
const WRITE_WORDS = new Set([
  'insert', 'update', 'delete', 'merge', 'upsert', 'create', 'alter', 'drop', 'truncate', 'grant', 'revoke',
  'copy', 'into', 'vacuum', 'reindex', 'cluster', 'listen', 'notify', 'unlisten', 'prepare', 'execute',
  'deallocate', 'discard', 'reset', 'set', 'begin', 'commit', 'rollback', 'savepoint', 'lock', 'do',
]);

/** Catalogs and system functions: a grant reads the allowlisted tables, not the server. */
const SYSTEM_WORDS = new Set(['information_schema', 'pg_catalog', 'pg_toast']);

/**
 * Functions that run SQL from a string, reach outside the database, change a
 * setting (the role among them) or read files. Strings are opaque to the table
 * check, so anything that executes one is refused outright.
 */
const FORBIDDEN_FUNCTION = /^(set_config|current_setting|dblink\w*|lo_\w+|\w*_to_xml\w*|query_to_\w+|ts_stat|ts_rewrite)$/;

/** Statement may start with these. */
const START_WORDS = new Set(['select', 'with']);

export interface SqlCheckOptions {
  /** Tables the grant reads. */
  allowedTables: readonly string[];
  /** Every table the schema defines: any of them not allowed is refused by name. */
  knownTables: readonly string[];
}

export type SqlCheck =
  | { ok: true; sql: string }
  | { ok: false; code: SqlRefusal; error: string };

/**
 * Is this one read-only SELECT over allowlisted tables? Returns the statement
 * with trailing semicolons removed, ready to wrap. A name in a string literal
 * is not checked here; the query role's privileges cover that case.
 */
export function checkReadOnlySql(raw: string, opts: SqlCheckOptions): SqlCheck {
  const refuse = (code: SqlRefusal, error: string): SqlCheck => ({ ok: false, code, error });
  const text = raw.trim();
  if (!text) return refuse('empty', 'sql is empty');
  if (text.length > DATABASE_QUERY_LIMITS.maxSqlChars) return refuse('too_long', `sql is longer than ${DATABASE_QUERY_LIMITS.maxSqlChars} characters`);
  const tokens = tokenize(text);
  if (!tokens) return refuse('unterminated', 'sql has an unterminated string, identifier or comment');
  while (tokens.length > 0 && tokens[tokens.length - 1].kind === 'punct' && tokens[tokens.length - 1].value === ';') tokens.pop();
  if (tokens.length === 0) return refuse('empty', 'sql is empty');
  if (tokens.some(t => t.kind === 'punct' && t.value === ';')) return refuse('multiple_statements', 'one statement per call: remove the extra semicolons');
  const first = tokens.find(t => !(t.kind === 'punct' && t.value === '('));
  if (!first || first.kind !== 'word' || !START_WORDS.has(first.value)) {
    return refuse('not_select', 'only a SELECT (or WITH … SELECT) runs under a read grant');
  }

  const allowed = new Set(opts.allowedTables);
  const known = new Set(opts.knownTables);
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === 'word' && WRITE_WORDS.has(t.value)) {
      return refuse('write_keyword', `"${t.value.toUpperCase()}" is not allowed: a read grant runs one SELECT and changes nothing`);
    }
    if (t.kind !== 'word' && t.kind !== 'quoted') continue;
    const name = t.value;
    if (SYSTEM_WORDS.has(name.toLowerCase()) || name.toLowerCase().startsWith('pg_')) {
      return refuse('system_catalog', `"${name}" is a system catalog or function; a read grant covers ${opts.allowedTables.length} tables only`);
    }
    const next = tokens[k + 1];
    if (t.kind === 'word' && next?.kind === 'punct' && next.value === '(' && FORBIDDEN_FUNCTION.test(name)) {
      return refuse('function_not_allowed', `${name}() is not allowed under a read grant`);
    }
    if (known.has(name) && !allowed.has(name)) {
      return refuse('table_not_allowed', `table "${name}" is outside this grant; it reads ${[...allowed].join(', ')}. (A column or alias with that name is refused too: rename it.)`);
    }
  }
  return { ok: true, sql: text.replace(/[;\s]+$/, '') };
}

/**
 * The statement as sent: a subquery under a row cap. A data-modifying WITH is
 * not allowed below the top level, so the wrap is a fourth refusal of writes.
 * The newline keeps a trailing line comment from swallowing the close.
 */
export function wrapWithRowCap(sql: string, maxRows: number): string {
  return `SELECT * FROM (\n${sql}\n) AS buildd_query LIMIT ${Math.floor(maxRows) + 1}`;
}

// ── Request ──────────────────────────────────────────────────────────────────

export type QueryParam = string | number | boolean | null;

export interface DatabaseQueryRequest {
  sql: string;
  params: QueryParam[];
  maxRows: number;
}

/** Things a query call never takes: buildd picks the database and holds the credential. */
export const DATABASE_QUERY_FORBIDDEN_FIELDS = ['connectionString', 'databaseUrl', 'url', 'host', 'role', 'password', 'token', 'apiKey', 'database'] as const;

export function parseDatabaseQueryRequest(body: unknown): { ok: true; request: DatabaseQueryRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Body must be an object' };
  const b = body as Record<string, unknown>;
  for (const k of DATABASE_QUERY_FORBIDDEN_FIELDS) {
    if (k in b) return { ok: false, error: `${k} is not accepted: buildd picks the database and the read-only role; pass only sql, params and maxRows` };
  }
  for (const k of Object.keys(b)) if (!['sql', 'params', 'maxRows'].includes(k)) return { ok: false, error: `unknown field ${k}` };
  if (typeof b.sql !== 'string' || !b.sql.trim()) return { ok: false, error: 'sql is required: one SELECT' };
  let params: QueryParam[] = [];
  if (b.params !== undefined && b.params !== null) {
    if (!Array.isArray(b.params) || b.params.length > DATABASE_QUERY_LIMITS.maxParams
      || !b.params.every(p => p === null || ['string', 'number', 'boolean'].includes(typeof p))) {
      return { ok: false, error: `params must be an array of up to ${DATABASE_QUERY_LIMITS.maxParams} strings, numbers, booleans or nulls (for $1, $2, …)` };
    }
    params = b.params as QueryParam[];
  }
  let maxRows: number = DATABASE_QUERY_LIMITS.defaultRows;
  if (b.maxRows !== undefined && b.maxRows !== null) {
    if (typeof b.maxRows !== 'number' || !Number.isInteger(b.maxRows) || b.maxRows < 1 || b.maxRows > DATABASE_QUERY_LIMITS.maxRows) {
      return { ok: false, error: `maxRows must be an integer between 1 and ${DATABASE_QUERY_LIMITS.maxRows}` };
    }
    maxRows = b.maxRows;
  }
  return { ok: true, request: { sql: b.sql, params, maxRows } };
}

// ── Invocation ───────────────────────────────────────────────────────────────

export interface QueryPrincipal {
  teamId: string | null;
  workspaceId: string;
  taskId: string;
  workerId: string;
}

export type GrantLookup =
  | { ok: true; grantId: string; expiresAt: Date }
  | { ok: false; reasonCode: string };

export interface ExecuteResult {
  rows: Record<string, unknown>[];
  fields: string[];
}

/** A Postgres refusal (permission denied, read-only transaction, timeout) as it comes back. */
export class QueryExecutionError extends Error {
  constructor(message: string, readonly sqlstate: string | null) {
    super(message);
  }
}

/** One audit row: the SQL text, row count and duration. Never the rows. */
export interface QueryAuditRow {
  decision: 'allowed' | 'refused';
  grantId: string | null;
  reasonCode: string | null;
  expiresAt: Date | null;
  sideEffect: { sql: string; sqlTruncated: boolean; rowCount: number | null; durationMs: number | null; truncated?: boolean; sqlstate?: string | null };
}

export interface DatabaseQueryDeps {
  /** The live database.query grant for this run, re-checked on every call. */
  findGrant: (principal: QueryPrincipal) => Promise<GrantLookup>;
  /** Null when no read-only role is configured: the call refuses. */
  execute: ((sql: string, params: QueryParam[]) => Promise<ExecuteResult>) | null;
  knownTables: readonly string[];
  allowedTables?: readonly string[];
  audit: (row: QueryAuditRow) => void;
  now?: () => number;
}

export type DatabaseQueryOutcome =
  | { ok: true; rows: Record<string, unknown>[]; fields: string[]; rowCount: number; truncated: boolean; durationMs: number; grantId: string }
  | { ok: false; status: number; code: string; error: string; requestWith?: { tool: 'request_capability'; params: Record<string, unknown> } };

/** The request an agent with no grant makes. */
export const DATABASE_QUERY_REQUEST = {
  tool: 'request_capability' as const,
  params: { provider: DATABASE_QUERY_PROVIDER, access: 'read', reason: '<what this run reads and why>' },
};

function auditSql(sql: string) {
  const max = DATABASE_QUERY_LIMITS.auditSqlChars;
  return sql.length > max ? { sql: sql.slice(0, max), sqlTruncated: true } : { sql, sqlTruncated: false };
}

/**
 * Run one read under this run's grant. Order matters: the grant is checked
 * first (no grant answers with the request to make), then the SQL, then the
 * role; only then is anything sent. Every outcome writes one audit row.
 */
export async function runDatabaseQuery(principal: QueryPrincipal, req: DatabaseQueryRequest, deps: DatabaseQueryDeps): Promise<DatabaseQueryOutcome> {
  const now = deps.now ?? Date.now;
  const logged = auditSql(req.sql);
  const refuse = (status: number, code: string, error: string, grant: { grantId: string; expiresAt: Date } | null, extra: Partial<QueryAuditRow['sideEffect']> = {}): DatabaseQueryOutcome => {
    deps.audit({ decision: 'refused', grantId: grant?.grantId ?? null, reasonCode: code, expiresAt: grant?.expiresAt ?? null, sideEffect: { ...logged, rowCount: null, durationMs: null, ...extra } });
    return { ok: false, status, code, error, ...(code === 'no_grant' ? { requestWith: DATABASE_QUERY_REQUEST } : {}) };
  };

  const grant = await deps.findGrant(principal);
  if (!grant.ok) {
    return refuse(403, 'no_grant', `No live database.query grant for this run (${grant.reasonCode}). Ask with request_capability { provider: "neon", access: "read" }; a person (or the team's Neon read policy) decides, then call this again.`, null);
  }
  const live = { grantId: grant.grantId, expiresAt: grant.expiresAt };

  const checked = checkReadOnlySql(req.sql, { allowedTables: deps.allowedTables ?? DATABASE_QUERY_TABLES, knownTables: deps.knownTables });
  if (!checked.ok) return refuse(400, checked.code, checked.error, live);

  if (!deps.execute) {
    return refuse(503, 'query_role_unconfigured', 'This deployment has no read-only query role configured (BUILDD_QUERY_DATABASE_URL). A platform admin sets it up with scripts/query-role-grants.ts; nothing falls back to the owner connection.', live);
  }

  const started = now();
  let result: ExecuteResult;
  try {
    result = await deps.execute(wrapWithRowCap(checked.sql, req.maxRows), req.params);
  } catch (err) {
    const durationMs = Math.max(0, Math.round(now() - started));
    const sqlstate = err instanceof QueryExecutionError ? err.sqlstate : null;
    const message = err instanceof QueryExecutionError ? err.message : 'the query failed';
    return refuse(400, sqlstate === '57014' ? 'statement_timeout' : 'query_failed', `Postgres refused the query: ${message}`, live, { durationMs, sqlstate });
  }
  const durationMs = Math.max(0, Math.round(now() - started));
  const truncated = result.rows.length > req.maxRows;
  const rows = truncated ? result.rows.slice(0, req.maxRows) : result.rows;
  deps.audit({ decision: 'allowed', grantId: live.grantId, reasonCode: null, expiresAt: live.expiresAt, sideEffect: { ...logged, rowCount: rows.length, durationMs, truncated } });
  return { ok: true, rows, fields: result.fields, rowCount: rows.length, truncated, durationMs, grantId: live.grantId };
}
