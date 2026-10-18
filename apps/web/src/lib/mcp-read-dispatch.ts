/**
 * MCP read actions call the API's own handlers in this process, not buildd's
 * HTTP API (spec 3ef37387 R-22). The MCP route used to `fetch` its own origin
 * for every read: a second function invocation, a second TLS round trip and a
 * second cold start per tool call, for an answer this process can compute.
 *
 * A GET whose path is in READ_ROUTES runs that route's `GET` with a request
 * built exactly as the HTTP call was (same URL, bearer and headers), so the
 * auth, scoping, shapes and loaders are the route's own, and nothing about the
 * answer changes. The read rate limit the proxy applies to an HTTP read is
 * applied here too, on the same subject. Every other call (writes, routes not
 * listed) still goes over HTTP.
 */
import { NextRequest } from 'next/server';
import { gateApiRead, rateLimitedResponse, readSubjectForKey } from './read-rate-limit';

export type ApiFn = (endpoint: string, options?: RequestInit) => Promise<any>;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> | Response;
interface ReadRoute { re: RegExp; params?: string[]; load: () => Promise<{ GET: Handler }> }

/** The reads MCP actions make, by path (query aside). Lazy: a tool call loads only the route it reads. */
export const READ_ROUTES: readonly ReadRoute[] = [
  { re: /^\/api\/tasks$/, load: () => import('@/app/api/tasks/route') as never },
  { re: /^\/api\/tasks\/([^/]+)$/, params: ['id'], load: () => import('@/app/api/tasks/[id]/route') as never },
  { re: /^\/api\/missions$/, load: () => import('@/app/api/missions/route') as never },
  { re: /^\/api\/missions\/([^/]+)$/, params: ['id'], load: () => import('@/app/api/missions/[id]/route') as never },
  { re: /^\/api\/workspaces$/, load: () => import('@/app/api/workspaces/route') as never },
  { re: /^\/api\/workers\/([^/]+)$/, params: ['id'], load: () => import('@/app/api/workers/[id]/route') as never },
  { re: /^\/api\/prs$/, load: () => import('@/app/api/prs/route') as never },
  { re: /^\/api\/roles$/, load: () => import('@/app/api/roles/route') as never },
  { re: /^\/api\/workspaces\/([^/]+)\/schedules$/, params: ['id'], load: () => import('@/app/api/workspaces/[id]/schedules/route') as never },
  { re: /^\/api\/workspaces\/([^/]+)\/skills$/, params: ['id'], load: () => import('@/app/api/workspaces/[id]/skills/route') as never },
  { re: /^\/api\/github\/pr\/review$/, load: () => import('@/app/api/github/pr/review/route') as never },
];

/** The route and its params for a GET endpoint, or null to go over HTTP. */
export function matchReadRoute(endpoint: string, routes: readonly ReadRoute[] = READ_ROUTES): { route: ReadRoute; params: Record<string, string> } | null {
  const path = endpoint.split('?')[0]!;
  for (const route of routes) {
    const m = route.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    (route.params ?? []).forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]!); });
    return { route, params };
  }
  return null;
}

export interface InProcessDeps {
  routes?: readonly ReadRoute[];
  gate?: typeof gateApiRead;
}

/**
 * Wrap the HTTP api: listed GETs run in process, with the headers the HTTP
 * call would carry (`headersFor`), and fail the way it would (`API error: <status> - <body>`).
 */
export function withInProcessReads(
  http: ApiFn,
  opts: { baseUrl: string; bearer: string; headersFor: (options: RequestInit) => Record<string, string> },
  deps: InProcessDeps = {},
): ApiFn {
  return async (endpoint, options = {}) => {
    const method = (options.method ?? 'GET').toUpperCase();
    const hit = method === 'GET' ? matchReadRoute(endpoint, deps.routes) : null;
    if (!hit) return http(endpoint, options);

    const url = new URL(endpoint, opts.baseUrl);
    const verdict = await (deps.gate ?? gateApiRead)({ method, pathname: url.pathname }, readSubjectForKey(opts.bearer));
    let res: Response;
    if (!verdict.allowed) {
      res = rateLimitedResponse(verdict);
    } else {
      const { GET } = await hit.route.load();
      const req = new NextRequest(url, { method, headers: opts.headersFor(options), signal: options.signal ?? undefined });
      res = await GET(req, { params: Promise.resolve(hit.params) });
    }
    if (!res.ok) throw new Error(`API error: ${res.status} - ${await res.text()}`);
    return res.json();
  };
}
