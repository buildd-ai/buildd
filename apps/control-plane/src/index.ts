/**
 * Execution control plane: serves the execution path (claim, worker
 * heartbeats and results, GitHub webhooks, Dispatch resolve and receipts) from
 * the same route handlers apps/web runs, on Cloudflare, so already-authorized
 * work keeps moving while the web app is down. Nothing routes here until the
 * cutover switch exists; see docs/specs/execution-control-plane.md.
 */
import { NextRequest } from './next-server-shim';
import { runInRequest } from './request-context';
import { installOutboundFetch } from './outbound-fetch';

installOutboundFetch();

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

interface Env { EXECUTION_MODE?: string; CONTROL_PLANE_HOST?: string; CRON_SECRET?: string; GIT_SHA?: string }

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // The Worker's own hostname has no origin behind it.
    const ownHost = !!env.CONTROL_PLANE_HOST && url.hostname === env.CONTROL_PLANE_HOST;
    if (url.pathname === '/__control-plane/health') {
      const health: Record<string, unknown> = { ok: true, service: 'control-plane', mode: executionMode(env.EXECUTION_MODE), commit: env.GIT_SHA ?? null };
      // ?deep=1: an unauthenticated GitHub API call through the outbound
      // fetch, the dependency the 2026-10-10 cutover lost (no User-Agent).
      // Probes report ok/fail and a status code, never upstream error text.
      if (url.searchParams.get('deep') === '1') {
        if (!deepHealthAllowed(request, env)) return new Response('Not Found', { status: 404 });
        const gh = await fetch('https://api.github.com/zen').catch(() => ({ status: 0, headers: new Headers() }) as Response);
        const anonymous = anonymousGithubProbe(gh.status, gh.headers?.get('x-ratelimit-remaining') ?? null);
        health.github = anonymous.report;
        // And as the GitHub App, with the real key: the JWT the installation
        // tokens are minted from.
        const app = await import('@/lib/github')
          .then(async ({ generateAppJWT }) => fetch('https://api.github.com/app', { headers: { Authorization: `Bearer ${await generateAppJWT()}`, Accept: 'application/vnd.github+json' } }))
          .catch(() => ({ status: 0 }) as Response);
        health.githubApp = app.status;
        // Realtime: the dashboard learns of claims and progress through Pusher.
        health.pusher = await import('@/lib/pusher')
          .then(({ triggerEventChecked }) => triggerEventChecked('control-plane-health', 'ping', { at: Date.now() }))
          .catch(() => 'error');
        // Object storage (run evidence, uploads): a HEAD of a key that cannot
        // exist must answer "not there", not throw.
        health.storage = await import('@/lib/storage')
          .then(async ({ isStorageConfigured, objectExists }) => (isStorageConfigured() ? ((await objectExists('control-plane-health/none')) ? 'unexpected' : 'ok') : 'unconfigured'))
          .catch(() => 'error');
        // Cache (API-key lookups): a miss must answer null, not throw.
        health.redis = await import('@/lib/redis')
          .then(async ({ isRedisConfigured, getCachedApiKey }) => (isRedisConfigured() ? ((await getCachedApiKey('control-plane-health')) === null ? 'ok' : 'unexpected') : 'unconfigured'))
          .catch(() => 'error');
        health.ok = anonymous.healthy && app.status === 200 && health.pusher === 'sent' && health.storage === 'ok' && health.redis === 'ok';
      }
      return Response.json(health, { status: health.ok ? 200 : 503 });
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
