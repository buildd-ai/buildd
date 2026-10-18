/**
 * MCP read actions call the API's own loaders in this process, not buildd's
 * HTTP API (spec 3ef37387 R-22).
 *
 * The MCP route hands its tools an `api(endpoint, init)` function
 * (packages/core/mcp-tools.ts `ApiFn`). It used to `fetch` this server's own
 * origin for every call: one more HTTP request through the edge, the proxy and
 * a fresh function per tool read, for an answer the same process could give.
 * A GET whose path is in `MCP_LOCAL_READS` (apps/web/src/modules.ts) now runs that route's own `GET`
 * handler directly, with the same request a fetch would have sent (the
 * caller's bearer, the interactive-session and grant-workspace headers), so
 * auth, scoping and the response shape are the route's, unchanged.
 *
 * What the proxy did for those requests still happens: the read rate limit
 * (proxy.ts `apiReadProxy`) is asked first and its 429 is returned as is.
 *
 * Writes, and any GET not in the table, still go over HTTP. Static segments
 * are listed before the dynamic ones they would otherwise match
 * (`/api/workspaces/by-repo` before `/api/workspaces/[id]`).
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
 * The table lives in the composition root (`MCP_LOCAL_READS`, apps/web/src/modules.ts):
 * it imports route modules of every module, which core may not
 * (scripts/module-boundaries.ts). Read once, when the first MCP read runs.
 */
async function localReads(): Promise<readonly LocalRead[]> {
  const modules = (await import('@/modules')) as { MCP_LOCAL_READS?: readonly LocalRead[] };
  return modules.MCP_LOCAL_READS ?? [];
}

/** The table entry and dynamic params for a pathname, or null when it goes over HTTP. */
export function matchLocalRead(pathname: string, table: readonly LocalRead[]): { read: LocalRead; params: Record<string, string> } | null {
  const segs = pathname.replace(/\/+$/, '').split('/');
  for (const read of table) {
    const pat = read.path.split('/');
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      if (pat[i].startsWith(':')) {
        if (!segs[i]) { ok = false; break; }
        try { params[pat[i].slice(1)] = decodeURIComponent(segs[i]); } catch { ok = false; break; }
      } else if (pat[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) return { read, params };
  }
  return null;
}

export interface LocalReadDeps {
  /** The proxy's read rate limit; a non-2xx/3xx answer is returned instead of running the route. */
  gate?: (req: NextRequest) => Promise<Response>;
  /** Tests: load a route module in place of the table's import. */
  load?: (read: LocalRead) => Promise<unknown>;
  /** Tests: the table in place of the composition root's. */
  table?: readonly LocalRead[];
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
  const m = matchLocalRead(parsed.pathname, deps.table ?? await localReads());
  if (!m) return null;
  const req = new NextRequest(parsed, { method: 'GET', headers });
  const gated = await (deps.gate ?? defaultGate)(req);
  if (gated.status === 429) return gated;
  const mod = (await (deps.load ?? (r => r.load()))(m.read)) as RouteModule;
  if (typeof mod.GET !== 'function') return null;
  return mod.GET(req, { params: Promise.resolve(m.params) });
}
