#!/usr/bin/env bun
/**
 * A stand-in for the local neon-http proxy, for CI's `db-architecture` job.
 *
 * The app talks to Postgres through `@neondatabase/serverless`'s HTTP driver:
 * one POST to `<fetchEndpoint>` per query, or per batch. Locally and in CI that
 * endpoint used to be ghcr.io/timowilhelm/local-neon-http-proxy, which pays two
 * control-plane lookups, a SCRAM handshake and a fresh Postgres connection on
 * every request — about 150-250ms for a query Postgres answers in a few. With
 * ~1,300 migration statements and every DB test query going through it, that
 * proxy was most of the job's wall time.
 *
 * This speaks the same subset of the protocol the driver uses (read off
 * @neondatabase/serverless 1.x `neon()` and checked against the proxy's actual
 * responses), backed by a persistent `pg` pool:
 *
 *   request   POST /sql, headers Neon-Connection-String, Neon-Raw-Text-Output:
 *             true, Neon-Array-Mode: true, and for a batch the optional
 *             Neon-Batch-Isolation-Level / -Read-Only / -Deferrable.
 *             Body {query, params} or {queries: [{query, params}, ...]}.
 *             Params arrive already serialised to text (or null) by the driver.
 *   success   200 {fields, rows, command, rowCount, rowAsArray: true}, rows as
 *             arrays of raw text (null for SQL NULL), fields carrying the
 *             dataTypeID the driver picks its type parser by. A batch is
 *             {results: [...]} and runs in ONE transaction.
 *   failure   400 {message, severity, code, detail, ...} with every field the
 *             driver copies onto its NeonDbError (null when Postgres sent none);
 *             a batch that fails is rolled back and answers the same way.
 *
 * Fidelity points that are easy to get wrong, each one a difference a test would
 * otherwise see between CI and production:
 *   - Every statement goes over the EXTENDED protocol, params or not, exactly
 *     like the proxy. `pg` would otherwise use the simple protocol for a
 *     parameterless query, which accepts `a; b` in one string — and a migration
 *     or query that only works that way would pass here and fail in production.
 *   - Each request gets a fresh session: the proxy opens a new connection per
 *     request, so SET, temp tables and advisory locks never outlive it. Pooled
 *     connections are `DISCARD ALL`ed after use (and dropped if that fails, e.g.
 *     a lone `BEGIN` left a transaction open).
 *   - The driver's own Neon-Connection-String is honoured, one pool per string,
 *     so a caller pointing DATABASE_URL at another database on the same server
 *     gets that database. Loopback hosts only: this must never become a way to
 *     reach a real database.
 *
 * Usage: `bun scripts/ci/neon-sql-shim.ts` (NEON_SQL_SHIM_PORT, default 4444),
 * then NEON_LOCAL_FETCH_ENDPOINT=http://127.0.0.1:4444/sql.
 */
import pg from 'pg';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The NeonDbError fields the driver copies from a 400 body (`Bu` in its source). */
export const NEON_ERROR_FIELDS = [
  'severity', 'code', 'detail', 'hint', 'position', 'internalPosition', 'internalQuery', 'where',
  'schema', 'table', 'column', 'dataType', 'constraint', 'file', 'line', 'routine',
] as const;

const ISOLATION_LEVELS: Record<string, string> = {
  ReadUncommitted: 'READ UNCOMMITTED',
  ReadCommitted: 'READ COMMITTED',
  RepeatableRead: 'REPEATABLE READ',
  Serializable: 'SERIALIZABLE',
};

/** Keep every value as the raw text Postgres sent; the driver parses it by dataTypeID. */
const RAW_TEXT_TYPES = { getTypeParser: () => (value: string) => value };

/** The slice of a `pg` client the shim uses — narrow so a test can fake it. */
export interface ShimClient {
  query(config: {
    text: string;
    values?: unknown[];
    rowMode?: 'array';
    types?: typeof RAW_TEXT_TYPES;
    queryMode?: 'extended';
  }): Promise<{
    fields: Array<{ name: string; dataTypeID: number; tableID: number; columnID: number; dataTypeSize: number; dataTypeModifier: number; format: string }>;
    rows: unknown[][];
    command: string;
    rowCount: number | null;
  }>;
  release(destroy?: boolean | Error): void;
}
export interface ShimPool {
  connect(): Promise<ShimClient>;
  end(): Promise<void>;
}

export type PoolFactory = (connectionString: string) => ShimPool;

const defaultPoolFactory: PoolFactory = (connectionString) => {
  const pool = new pg.Pool({ connectionString, max: Number(process.env.NEON_SQL_SHIM_POOL_MAX ?? 20) });
  // An idle client dying (server restart) must not take the shim down with it.
  pool.on('error', (err) => console.error('[neon-sql-shim] idle client error:', err.message));
  return pool as unknown as ShimPool;
};

class ShimRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface WireQuery { query: string; params: unknown[] }

function parseQuery(raw: unknown): WireQuery {
  const q = raw as Partial<WireQuery> | null;
  if (!q || typeof q.query !== 'string') throw new ShimRequestError(400, 'request needs a string `query`');
  if (q.params !== undefined && !Array.isArray(q.params)) throw new ShimRequestError(400, '`params` must be an array');
  return { query: q.query, params: q.params ?? [] };
}

export function assertLoopbackConnectionString(connectionString: string | null): string {
  if (!connectionString) throw new ShimRequestError(400, 'missing Neon-Connection-String header');
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new ShimRequestError(400, 'Neon-Connection-String is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ShimRequestError(400, 'Neon-Connection-String must be a postgres:// URL');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ShimRequestError(403, `refusing non-loopback database host "${url.hostname}"`);
  }
  return connectionString;
}

function toWireResult(r: Awaited<ReturnType<ShimClient['query']>>) {
  return {
    fields: r.fields.map((f) => ({
      name: f.name,
      dataTypeID: f.dataTypeID,
      tableID: f.tableID,
      columnID: f.columnID,
      dataTypeSize: f.dataTypeSize,
      dataTypeModifier: f.dataTypeModifier,
      format: f.format,
    })),
    rows: r.rows,
    command: r.command,
    rowCount: r.rowCount ?? null,
    rowAsArray: true,
  };
}

/** A Postgres error (it has a SQLSTATE) becomes the 400 body the driver turns into NeonDbError. */
export function toWireError(err: unknown): Record<string, unknown> | null {
  const e = err as Record<string, unknown> | null;
  if (!e || typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code)) return null;
  const body: Record<string, unknown> = { message: String(e.message ?? '') };
  for (const field of NEON_ERROR_FIELDS) body[field] = e[field] ?? null;
  return body;
}

function runOne(client: ShimClient, q: WireQuery) {
  return client.query({
    text: q.query,
    values: q.params,
    rowMode: 'array',
    types: RAW_TEXT_TYPES,
    queryMode: 'extended',
  });
}

function beginStatement(headers: Headers): string {
  const parts = ['BEGIN'];
  const level = headers.get('Neon-Batch-Isolation-Level');
  if (level) {
    const sqlLevel = ISOLATION_LEVELS[level];
    if (!sqlLevel) throw new ShimRequestError(400, `unknown Neon-Batch-Isolation-Level "${level}"`);
    parts.push('ISOLATION LEVEL', sqlLevel);
  }
  const readOnly = headers.get('Neon-Batch-Read-Only');
  if (readOnly === 'true') parts.push('READ ONLY');
  else if (readOnly === 'false') parts.push('READ WRITE');
  const deferrable = headers.get('Neon-Batch-Deferrable');
  if (deferrable === 'true') parts.push('DEFERRABLE');
  else if (deferrable === 'false') parts.push('NOT DEFERRABLE');
  return parts.join(' ');
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export interface NeonSqlShim {
  fetch(req: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createNeonSqlShim(opts: { poolFactory?: PoolFactory } = {}): NeonSqlShim {
  const poolFactory = opts.poolFactory ?? defaultPoolFactory;
  const pools = new Map<string, ShimPool>();
  const poolFor = (cs: string) => {
    let pool = pools.get(cs);
    if (!pool) {
      pool = poolFactory(cs);
      pools.set(cs, pool);
    }
    return pool;
  };

  async function handle(req: Request): Promise<Response> {
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/sql') {
      throw new ShimRequestError(404, 'only POST /sql is served');
    }
    // The driver always asks for raw text in array mode; that is the only
    // shape this shim produces, so anything else is a caller this was not
    // built for, refused rather than answered in the wrong shape.
    if (req.headers.get('Neon-Raw-Text-Output') !== 'true' || req.headers.get('Neon-Array-Mode') !== 'true') {
      throw new ShimRequestError(400, 'only Neon-Raw-Text-Output: true + Neon-Array-Mode: true is supported');
    }
    const pool = poolFor(assertLoopbackConnectionString(req.headers.get('Neon-Connection-String')));

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new ShimRequestError(400, 'body is not JSON');
    }
    const batch = Array.isArray((body as { queries?: unknown })?.queries)
      ? ((body as { queries: unknown[] }).queries.map(parseQuery))
      : null;
    const single = batch ? null : parseQuery(body);
    const begin = batch ? beginStatement(req.headers) : null;

    const client = await pool.connect();
    let healthy = true;
    try {
      if (single) return json(200, toWireResult(await runOne(client, single)));

      await client.query({ text: begin! });
      try {
        const results = [];
        for (const q of batch!) results.push(toWireResult(await runOne(client, q)));
        await client.query({ text: 'COMMIT' });
        return json(200, { results });
      } catch (err) {
        try {
          await client.query({ text: 'ROLLBACK' });
        } catch {
          healthy = false;
        }
        throw err;
      }
    } finally {
      // Fresh-session semantics: nothing a request did to its session (SET,
      // temp tables, advisory locks, an open transaction) reaches the next one.
      if (healthy) {
        try {
          await client.query({ text: 'DISCARD ALL' });
        } catch {
          healthy = false;
        }
      }
      client.release(healthy ? undefined : true);
    }
  }

  return {
    async fetch(req) {
      try {
        return await handle(req);
      } catch (err) {
        if (err instanceof ShimRequestError) return new Response(err.message, { status: err.status });
        const wire = toWireError(err);
        if (wire) return json(400, wire);
        // Not a Postgres error (connection refused, pool exhausted…): the
        // driver reports a non-400 as "Server error (HTTP status N): <text>".
        return new Response(err instanceof Error ? err.message : String(err), { status: 500 });
      }
    },
    async close() {
      await Promise.all([...pools.values()].map((p) => p.end()));
      pools.clear();
    },
  };
}

if (import.meta.main) {
  const port = Number(process.env.NEON_SQL_SHIM_PORT ?? 4444);
  const shim = createNeonSqlShim();
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: (req) => shim.fetch(req) });
  console.log(`[neon-sql-shim] listening on http://127.0.0.1:${server.port}/sql`);
  const stop = async () => {
    server.stop();
    await shim.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
