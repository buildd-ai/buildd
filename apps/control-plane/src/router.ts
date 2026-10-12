/**
 * The control plane's routing and health helpers. Kept out of index.ts on
 * purpose: workerd treats every named export of the main module as an
 * entrypoint and refuses to start when one is not a handler (a string or an
 * array, e.g. SERVED_BY or ROUTES), so index.ts exports only `default`.
 */
import type { NextRequest } from './next-server-shim';

export type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
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

export interface Env { EXECUTION_MODE?: string; CONTROL_PLANE_HOST?: string; CRON_SECRET?: string; GIT_SHA?: string }

/**
 * Deep health makes outbound calls (GitHub, Pusher, storage, Redis) on every
 * request, so only a caller holding CRON_SECRET may ask for it; anyone else
 * gets the same 404 as a path that does not exist.
 */
export function deepHealthAllowed(request: Request, env: Env): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const got = request.headers.get('authorization') ?? '';
  const want = `Bearer ${secret}`;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

/**
 * The deep health's anonymous GitHub call. Unauthenticated calls share a small
 * hourly budget per egress IP, and a Worker's egress IP is shared with other
 * Cloudflare tenants, so the budget is often spent by someone else: GitHub
 * answers 403 with `x-ratelimit-remaining: 0`, or 429 for a secondary limit.
 * That says nothing about this Worker's outbound fetch, so it reads
 * `rate_limited` and keeps the probe healthy. A 403 with budget left is what
 * the 2026-10-10 cutover's missing User-Agent looked like, and still fails.
 * The App probe beside it proves the authenticated path either way.
 */
export function anonymousGithubProbe(status: number, rateLimitRemaining: string | null): { report: number | 'rate_limited'; healthy: boolean } {
  if (status === 429 || (status === 403 && rateLimitRemaining === '0')) return { report: 'rate_limited', healthy: true };
  return { report: status, healthy: status === 200 };
}

