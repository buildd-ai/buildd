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
/** One read route: its path pattern, the names of its dynamic segments, and its module, loaded on use. */
export interface McpReadRoute { re: RegExp; params?: string[]; load: () => Promise<{ GET: Handler }> }

/**
 * The table lives in the composition root (`MCP_READ_ROUTES`, apps/web/src/modules.ts):
 * several of these routes are modules', and core never imports a module
 * (scripts/module-boundaries.test.ts). Loaded on the first read, not when core loads.
 */
async function readRoutes(): Promise<readonly McpReadRoute[]> {
  const modules = (await import('@/modules')) as Record<string, unknown>;
  return (modules.MCP_READ_ROUTES as readonly McpReadRoute[] | undefined) ?? [];
}

/** The route and its params for a GET endpoint, or null to go over HTTP. */
export function matchReadRoute(endpoint: string, routes: readonly McpReadRoute[]): { route: McpReadRoute; params: Record<string, string> } | null {
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
  routes?: readonly McpReadRoute[];
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
    const hit = method === 'GET' ? matchReadRoute(endpoint, deps.routes ?? await readRoutes()) : null;
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
