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
];

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

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'control-plane' });
    const hit = matchRoute(request.method, url.pathname);
    if (!hit) return new Response('Not Found', { status: 404 });
    const handler = (await hit.route.load())[request.method] as Handler | undefined;
    if (!handler) return new Response('Method Not Allowed', { status: 405 });
    return runInRequest(p => ctx.waitUntil(p), () => handler(new NextRequest(request), { params: Promise.resolve(hit.params) }));
  },
};
