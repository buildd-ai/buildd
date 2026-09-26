/**
 * An `ApiFn` for the MCP action handlers that calls buildd's own route
 * handlers in-process, as the signed-in user.
 *
 * Chat tools reuse `handleBuilddAction` from packages/core/mcp-tools.ts, which
 * reaches the platform through REST routes. `/api/mcp` hands it an HTTP client
 * with a bearer token. Chat doesn't: a second HTTP hop and a minted token per
 * turn are exactly what docs/design/agent-chat.md rules out. Instead each
 * allowlisted (method, path) is dispatched straight to its route module. The
 * route runs inside the chat request, so `getCurrentUser()` resolves the same
 * session and the dashboard's own authorization applies — the approval card is
 * consent on top of that, never a replacement for it.
 *
 * Only the routes the chat tool allowlist needs are reachable. Anything else is
 * refused before dispatch, so a tool can't wander onto a write route.
 */

import { NextRequest } from 'next/server';
import type { ApiFn } from '@buildd/core/mcp-tools';

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteModule = Record<string, unknown>;

interface RouteEntry {
  /** Path pattern with `:param` segments, matching the app/api folder names. */
  pattern: string;
  methods: readonly string[];
  load: () => Promise<RouteModule>;
}

/** The whole reachable surface. Adding a chat tool means adding its routes here. */
export const CHAT_ROUTES: readonly RouteEntry[] = [
  { pattern: '/api/tasks', methods: ['GET'], load: () => import('@/app/api/tasks/route') },
  { pattern: '/api/tasks/:id', methods: ['GET'], load: () => import('@/app/api/tasks/[id]/route') },
  // POST is mission creation — reached only through an approved approval card.
  { pattern: '/api/missions', methods: ['GET', 'POST'], load: () => import('@/app/api/missions/route') },
  { pattern: '/api/missions/:id', methods: ['GET'], load: () => import('@/app/api/missions/[id]/route') },
  { pattern: '/api/missions/:id/evaluate', methods: ['GET'], load: () => import('@/app/api/missions/[id]/evaluate/route') },
  { pattern: '/api/workspaces', methods: ['GET'], load: () => import('@/app/api/workspaces/route') },
  { pattern: '/api/workspaces/:id/schedules', methods: ['GET'], load: () => import('@/app/api/workspaces/[id]/schedules/route') },
  {
    pattern: '/api/workspaces/:id/schedules/:scheduleId',
    methods: ['GET'],
    load: () => import('@/app/api/workspaces/[id]/schedules/[scheduleId]/route'),
  },
  { pattern: '/api/workspaces/:id/artifacts', methods: ['GET'], load: () => import('@/app/api/workspaces/[id]/artifacts/route') },
  { pattern: '/api/initiatives/:id/artifacts', methods: ['GET'], load: () => import('@/app/api/initiatives/[id]/artifacts/route') },
];

export function matchChatRoute(
  method: string,
  pathname: string,
  routes: readonly RouteEntry[] = CHAT_ROUTES,
): { entry: RouteEntry; params: Record<string, string> } | null {
  const segs = pathname.replace(/\/+$/, '').split('/');
  for (const entry of routes) {
    const pat = entry.pattern.split('/');
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      if (pat[i].startsWith(':')) {
        if (!segs[i]) { ok = false; break; }
        params[pat[i].slice(1)] = decodeURIComponent(segs[i]);
      } else if (pat[i] !== segs[i]) { ok = false; break; }
    }
    if (ok && entry.methods.includes(method)) return { entry, params };
  }
  return null;
}

export interface ApiCall {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

/**
 * @param origin  the chat request's origin, for building absolute URLs
 * @param headers the chat request's cookie/auth headers, forwarded as-is
 * @param onCall  sees every call and its parsed JSON (used to derive object refs)
 */
export function createInProcessApi(opts: {
  origin: string;
  headers: Headers;
  onCall?: (call: ApiCall) => void;
  routes?: readonly RouteEntry[];
}): ApiFn {
  return async (endpoint, options = {}) => {
    const method = (options.method ?? 'GET').toUpperCase();
    const url = new URL(endpoint, opts.origin);
    const match = matchChatRoute(method, url.pathname, opts.routes);
    if (!match) throw new Error(`API error: 403 - ${method} ${url.pathname} is not available from chat`);

    const mod = await match.entry.load();
    const handler = mod[method] as Handler | undefined;
    if (typeof handler !== 'function') throw new Error(`API error: 405 - ${method} ${url.pathname}`);

    const headers = new Headers();
    for (const name of ['cookie', 'authorization', 'user-agent']) {
      const v = opts.headers.get(name);
      if (v) headers.set(name, v);
    }
    headers.set('content-type', 'application/json');
    const req = new NextRequest(url, {
      method,
      headers,
      ...(options.body !== undefined && method !== 'GET' ? { body: options.body as BodyInit } : {}),
    });

    const res = await handler(req, { params: Promise.resolve(match.params) });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    opts.onCall?.({ method, path: url.pathname, status: res.status, body });
    if (!res.ok) throw new Error(`API error: ${res.status} - ${typeof body === 'string' ? body : text.slice(0, 500)}`);
    return body;
  };
}
