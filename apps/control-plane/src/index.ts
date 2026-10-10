/**
 * Execution control plane: serves the execution path (claim, worker
 * heartbeats and results, GitHub webhooks, Dispatch resolve and receipts) from
 * the same route handlers apps/web runs, on Cloudflare, so already-authorized
 * work keeps moving while the web app is down. Nothing routes here until the
 * cutover switch exists; see docs/specs/execution-control-plane.md.
 */
import { NextRequest } from './next-server-shim';
import { runInRequest } from './request-context';

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Route = { method: string; pattern: URLPattern; load: () => Promise<Record<string, unknown>> };

const route = (method: string, pathname: string, load: Route['load']): Route => ({ method, pattern: new URLPattern({ pathname }), load });

export const ROUTES: Route[] = [
  route('POST', '/api/workers/claim', () => import('@/app/api/workers/claim/route')),
  route('GET', '/api/workers/:id', () => import('@/app/api/workers/[id]/route')),
  route('PATCH', '/api/workers/:id', () => import('@/app/api/workers/[id]/route')),
  route('POST', '/api/github/webhook', () => import('@/app/api/github/webhook/route')),
  route('POST', '/api/dispatch/v1/resolve', () => import('@/app/api/dispatch/v1/resolve/route')),
  route('POST', '/api/dispatch/v1/receipts', () => import('@/app/api/dispatch/v1/receipts/route')),
  route('POST', '/api/dispatch/v1/relay', () => import('@/app/api/dispatch/v1/relay/route')),
];

/**
 * EXECUTION_MODE decides who answers the execution routes on buildd.dev:
 *  - `own`: this Worker runs them.
 *  - `shadow` (and anything unset or unknown): every request passes through to
 *    the web app unchanged. The switch back from `own` is this, and needs no
 *    DNS or route change.
 * Requests the Worker does not serve always pass through to the origin.
 */
export type ExecutionMode = 'own' | 'shadow';
export const executionMode = (raw: unknown): ExecutionMode => (raw === 'own' ? 'own' : 'shadow');
export const SERVED_BY = 'x-buildd-served-by';

function tag(res: Response, by: string): Response {
  const out = new Response(res.body, res);
  out.headers.set(SERVED_BY, by);
  return out;
}

/** The route a request addresses, with its path params; null when it is not an execution route. */
export function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.pattern.exec({ pathname });
    if (!m) continue;
    const params = Object.fromEntries(Object.entries(m.pathname.groups).filter(([, v]) => v !== undefined)) as Record<string, string>;
    return { route: r, params };
  }
  return null;
}

interface Env { EXECUTION_MODE?: string; CONTROL_PLANE_HOST?: string }

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // The Worker's own hostname has no origin behind it.
    const ownHost = !!env.CONTROL_PLANE_HOST && url.hostname === env.CONTROL_PLANE_HOST;
    if (url.pathname === '/__control-plane/health') {
      return Response.json({ ok: true, service: 'control-plane', mode: executionMode(env.EXECUTION_MODE) });
    }
    const hit = matchRoute(request.method, url.pathname);
    if (!hit || (!ownHost && executionMode(env.EXECUTION_MODE) !== 'own')) {
      // On a buildd.dev route a subrequest to the same URL goes to the origin
      // (Vercel), never back into this Worker.
      return ownHost ? new Response('Not Found', { status: 404 }) : tag(await fetch(request), 'web');
    }
    const handler = (await hit.route.load())[request.method] as Handler | undefined;
    if (!handler) return new Response('Method Not Allowed', { status: 405 });
    const res = await runInRequest(p => ctx.waitUntil(p), () => handler(new NextRequest(request), { params: Promise.resolve(hit.params) }));
    return tag(res, 'control-plane');
  },
};
