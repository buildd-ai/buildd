/**
 * MCP read actions call the API's own loaders in this process, not buildd's
 * HTTP API (spec 3ef37387 R-22).
 *
 * The MCP route hands its tools an `api(endpoint, init)` function
 * (packages/core/mcp-tools.ts `ApiFn`). It used to `fetch` this server's own
 * origin for every call: one more HTTP request through the edge, the proxy and
 * a fresh function per tool read, for an answer the same process could give.
 * A GET whose path is in `LOCAL_READS` now runs that route's own `GET`
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

interface LocalRead {
  /** Path segments; `:name` is a dynamic segment. */
  path: string;
  load: () => Promise<unknown>;
}

/** The read routes MCP actions call. Order matters: first match wins. */
export const LOCAL_READS: readonly LocalRead[] = [
  { path: '/api/tasks', load: () => import('@/app/api/tasks/route') },
  { path: '/api/tasks/:id', load: () => import('@/app/api/tasks/[id]/route') },
  { path: '/api/tasks/:id/messages', load: () => import('@/app/api/tasks/[id]/messages/route') },
  { path: '/api/tasks/:id/evidence', load: () => import('@/app/api/tasks/[id]/evidence/route') },
  { path: '/api/workspaces', load: () => import('@/app/api/workspaces/route') },
  { path: '/api/workspaces/by-repo', load: () => import('@/app/api/workspaces/by-repo/route') },
  { path: '/api/workspaces/across/:list', load: () => import('@/app/api/workspaces/across/[list]/route') },
  { path: '/api/workspaces/:id', load: () => import('@/app/api/workspaces/[id]/route') },
  { path: '/api/workspaces/:id/artifacts', load: () => import('@/app/api/workspaces/[id]/artifacts/route') },
  { path: '/api/workspaces/:id/schedules', load: () => import('@/app/api/workspaces/[id]/schedules/route') },
  { path: '/api/workspaces/:id/skills', load: () => import('@/app/api/workspaces/[id]/skills/route') },
  { path: '/api/workspaces/:id/readiness', load: () => import('@/app/api/workspaces/[id]/readiness/route') },
  { path: '/api/workspaces/:id/error-traces', load: () => import('@/app/api/workspaces/[id]/error-traces/route') },
  { path: '/api/missions', load: () => import('@/app/api/missions/route') },
  { path: '/api/missions/:id', load: () => import('@/app/api/missions/[id]/route') },
  { path: '/api/missions/:id/artifacts', load: () => import('@/app/api/missions/[id]/artifacts/route') },
  { path: '/api/prs', load: () => import('@/app/api/prs/route') },
  { path: '/api/github/pr', load: () => import('@/app/api/github/pr/route') },
  { path: '/api/artifacts/linked', load: () => import('@/app/api/artifacts/linked/route') },
  { path: '/api/artifacts/:artifactId', load: () => import('@/app/api/artifacts/[artifactId]/route') },
  { path: '/api/initiatives', load: () => import('@/app/api/initiatives/route') },
  { path: '/api/initiatives/:id', load: () => import('@/app/api/initiatives/[id]/route') },
  { path: '/api/initiatives/:id/artifacts', load: () => import('@/app/api/initiatives/[id]/artifacts/route') },
  { path: '/api/releases', load: () => import('@/app/api/releases/route') },
  { path: '/api/releases/status', load: () => import('@/app/api/releases/status/route') },
  { path: '/api/releases/:id', load: () => import('@/app/api/releases/[id]/route') },
  { path: '/api/roles', load: () => import('@/app/api/roles/route') },
  { path: '/api/roles/:id', load: () => import('@/app/api/roles/[id]/route') },
  { path: '/api/explain', load: () => import('@/app/api/explain/route') },
  { path: '/api/discrepancies', load: () => import('@/app/api/discrepancies/route') },
  { path: '/api/discrepancies/:id', load: () => import('@/app/api/discrepancies/[id]/route') },
  { path: '/api/health/failures', load: () => import('@/app/api/health/failures/route') },
  { path: '/api/health/dispatch', load: () => import('@/app/api/health/dispatch/route') },
  { path: '/api/stats/coordination', load: () => import('@/app/api/stats/coordination/route') },
  { path: '/api/stats/usage', load: () => import('@/app/api/stats/usage/route') },
  { path: '/api/specs/outcomes/:taskId', load: () => import('@/app/api/specs/outcomes/[taskId]/route') },
  { path: '/api/workers/:id', load: () => import('@/app/api/workers/[id]/route') },
];

/** The table entry and dynamic params for a pathname, or null when it goes over HTTP. */
export function matchLocalRead(pathname: string): { read: LocalRead; params: Record<string, string> } | null {
  const segs = pathname.replace(/\/+$/, '').split('/');
  for (const read of LOCAL_READS) {
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
  const m = matchLocalRead(parsed.pathname);
  if (!m) return null;
  const req = new NextRequest(parsed, { method: 'GET', headers });
  const gated = await (deps.gate ?? defaultGate)(req);
  if (gated.status === 429) return gated;
  const mod = (await (deps.load ?? (r => r.load()))(m.read)) as RouteModule;
  if (typeof mod.GET !== 'function') return null;
  return mod.GET(req, { params: Promise.resolve(m.params) });
}
