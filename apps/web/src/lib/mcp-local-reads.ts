/**
 * MCP read actions call the API's own loaders in this process, not buildd's
 * HTTP API (spec 3ef37387 R-22).
 *
 * The MCP route hands its tools an `api(endpoint, init)` function
 * (packages/core/mcp-tools.ts `ApiFn`). It used to `fetch` this server's own
 * origin for every call: one more HTTP request through the edge, the proxy and
 * a fresh function per tool read, for an answer the same process could give.
 * A GET whose path is in `MCP_LOCAL_READS` (apps/web/src/mcp-local-read-routes.ts) now runs that route's own `GET`
 * handler directly, with the same request a fetch would have sent (the
 * caller's bearer, the interactive-session and grant-workspace headers), so
 * auth, scoping and the response shape are the route's, unchanged.
 *
 * What the proxy did for those requests still happens: the read rate limit
 * (proxy.ts `apiReadProxy`) is asked first and its 429 is returned as is.
 *
 * Writes, and any GET not in the table, still go over HTTP. So does a GET a
 * route outside the table serves even though a table entry's dynamic segment
 * would match it (`/api/missions/capabilities`, not the mission named
 * "capabilities"): see `matchLocalRead`.
 */
import { NextRequest } from 'next/server';

type RouteGet = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteModule = { GET?: RouteGet };

export interface LocalRead {
  /** Path segments; `:name` is a dynamic segment. */
  path: string;
  load: () => Promise<unknown>;
}

/**
 * The table lives in its own composition root (`MCP_LOCAL_READS`,
 * apps/web/src/mcp-local-read-routes.ts): it imports route modules of every
 * module, which core may not (scripts/module-boundaries.ts). Not modules.ts:
 * pages import that, and the table would put every route in their graphs.
 * Read once, when the first MCP read runs.
 */
async function localReads(): Promise<{ table: readonly LocalRead[]; shadows: readonly string[] }> {
  const modules = (await import('@/mcp-local-read-routes')) as { MCP_LOCAL_READS?: readonly LocalRead[]; MCP_LOCAL_READ_SHADOWS?: readonly string[] };
  return { table: modules.MCP_LOCAL_READS ?? [], shadows: modules.MCP_LOCAL_READ_SHADOWS ?? [] };
}

const isDyn = (seg: string) => seg.startsWith(':');

/** Next.js precedence: at the first segment where two patterns differ in kind, the static one wins. */
function moreSpecific(a: string[], b: string[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (isDyn(a[i]) !== isDyn(b[i])) return !isDyn(a[i]);
  }
  return false;
}

function matchPattern(pat: string[], segs: string[]): Record<string, string> | null {
  if (pat.length !== segs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pat.length; i++) {
    if (isDyn(pat[i])) {
      if (!segs[i]) return null;
      try { params[pat[i].slice(1)] = decodeURIComponent(segs[i]); } catch { return null; }
    } else if (pat[i] !== segs[i]) return null;
  }
  return params;
}

/**
 * The table entry and dynamic params for a pathname, or null when it goes over HTTP.
 *
 * The entry Next.js itself would route to wins (the most specific, not the
 * first listed), and a path one of `shadows` matches is never a table entry's:
 * `shadows` are the routes not in the table that Next.js prefers over an
 * entry's dynamic segment (`/api/missions/capabilities` over
 * `/api/missions/:id`). Derived from the routes on disk by `shadowedRoutes`;
 * lib/mcp-local-reads.test.ts fails when the list in mcp-local-read-routes.ts drifts.
 */
export function matchLocalRead(
  pathname: string,
  table: readonly LocalRead[],
  shadows: readonly string[] = [],
): { read: LocalRead; params: Record<string, string> } | null {
  const segs = pathname.replace(/\/+$/, '').split('/');
  if (shadows.some(s => matchPattern(s.split('/'), segs))) return null;
  let best: { read: LocalRead; params: Record<string, string>; pat: string[] } | null = null;
  for (const read of table) {
    const pat = read.path.split('/');
    const params = matchPattern(pat, segs);
    if (params && (!best || moreSpecific(pat, best.pat))) best = { read, params, pat };
  }
  return best && { read: best.read, params: best.params };
}

/**
 * The routes (table-style paths) Next.js would serve in place of a table
 * entry for some path the entry's pattern matches: same length, every segment
 * compatible, and more specific at the first segment that differs in kind.
 * Routes that are themselves entries are not shadows.
 */
export function shadowedRoutes(routes: readonly string[], table: readonly LocalRead[]): string[] {
  const shape = (p: string) => p.replace(/:[^/]+/g, ':');
  const entries = new Set(table.map(r => shape(r.path)));
  return routes.filter(route => {
    if (entries.has(shape(route))) return false;
    const r = route.split('/');
    return table.some(({ path }) => {
      const t = path.split('/');
      if (t.length !== r.length) return false;
      if (!t.every((seg, i) => isDyn(seg) || isDyn(r[i]) || seg === r[i])) return false;
      return moreSpecific(r, t);
    });
  }).sort();
}

export interface LocalReadDeps {
  /** The proxy's read rate limit; a non-2xx/3xx answer is returned instead of running the route. */
  gate?: (req: NextRequest) => Promise<Response>;
  /** Tests: load a route module in place of the table's import. */
  load?: (read: LocalRead) => Promise<unknown>;
  /** Tests: the table in place of the composition root's. */
  table?: readonly LocalRead[];
  /** Tests: the shadowed routes in place of the composition root's. */
  shadows?: readonly string[];
}

async function defaultGate(req: NextRequest): Promise<Response> {
  const { apiReadProxy } = await import('@/proxy');
  return apiReadProxy(req);
}

/**
 * Run a GET in-process when its route is in the table. Returns null when it
 * is not (the caller fetches over HTTP).
 */
export async function runLocalRead(url: string, headers: Record<string, string>, deps: LocalReadDeps = {}): Promise<Response | null> {
  const parsed = new URL(url);
  const root = deps.table ? null : await localReads();
  const m = matchLocalRead(parsed.pathname, deps.table ?? root!.table, deps.shadows ?? root?.shadows ?? []);
  if (!m) return null;
  const req = new NextRequest(parsed, { method: 'GET', headers });
  const gated = await (deps.gate ?? defaultGate)(req);
  if (gated.status === 429) return gated;
  const mod = (await (deps.load ?? (r => r.load()))(m.read)) as RouteModule;
  if (typeof mod.GET !== 'function') return null;
  return mod.GET(req, { params: Promise.resolve(m.params) });
}
