/**
 * Execution control plane: serves the execution path (claim, worker
 * heartbeats and results, GitHub webhooks, Dispatch resolve and receipts) from
 * the same route handlers apps/web runs, on Cloudflare, so already-authorized
 * work keeps moving while the web app is down. EXECUTION_MODE (router.ts)
 * decides whether it answers them; see docs/specs/execution-control-plane.md.
 */
import { NextRequest } from './next-server-shim';
import { runInRequest } from './request-context';
import { installOutboundFetch } from './outbound-fetch';
import { anonymousGithubProbe, deepHealthAllowed, executionMode, isCommandRequest, matchRoute, SERVED_BY, type Env, type Handler } from './router';
import { setKernelHost } from '@/lib/workflow/kernel-host';

installOutboundFetch();
// This process is the kernel's control-plane host: every transition it applies is tagged so (AC-9).
setKernelHost('control-plane');

/** The handlers read config from process.env; the bindings the runtime hands this call win. */
const envOf = (env: Env): Record<string, string | undefined> => ({ ...(process.env as Record<string, string | undefined>), ...(env as Record<string, string | undefined>) });

function tag(res: Response, by: string): Response {
  const out = new Response(res.body, res);
  out.headers.set(SERVED_BY, by);
  return out;
}

// The main module's only export: see router.ts.
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
    // The kernel command API: the Worker's own hostname only.
    if (isCommandRequest(request.method, url.pathname, ownHost)) {
      const { handleCommandRequest } = await import('@/lib/workflow/command-api');
      const res = await runInRequest(p => ctx.waitUntil(p), () => handleCommandRequest(request, { env: envOf(env) }));
      return tag(res, 'control-plane');
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

  // The cron trigger (wrangler.jsonc `triggers.crons`): the kernel's effect drain and floor,
  // hosted here in own mode and a no-op in shadow (workflow-kernel-library.md §3, AC-10).
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await runInRequest(p => ctx.waitUntil(p), async () => {
      const { runScheduledKernelFloor } = await import('@/lib/workflow/kernel-floor');
      const r = await runScheduledKernelFloor({ env: envOf(env) });
      if (!r.ran) console.log(`[kernel-floor] skipped: ${r.reason}`);
    });
  },
};
