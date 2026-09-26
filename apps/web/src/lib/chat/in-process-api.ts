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

/**
 * What one conversation's tools may touch: its own team, and only that team's
 * standard (non-sensitive) workspaces. A chat turn sends tool output to a model
 * provider on the conversation team's key, so a workspace outside this set —
 * sensitive, or another team's that the same person also belongs to — is out
 * of reach even though the user could open it in the dashboard.
 *
 * Enforced here, on every call, rather than trusted to tool arguments: the
 * model (and anything it has read) picks those.
 */
export interface ChatReach {
  teamId: string;
  workspaceIds: ReadonlySet<string>;
  /** Owning team/workspace of an id-addressed object; null when unknown. */
  ownerOf: (kind: 'task' | 'mission' | 'initiative', id: string) => Promise<ChatObjectOwner | null>;
}

export interface ChatObjectOwner {
  teamId: string | null;
  workspaceId: string | null;
  /** Workspaces of the object's children (a mission's tasks); all must be in reach. */
  childWorkspaceIds?: readonly string[];
}

const OUT_OF_REACH = 'API error: 404 - Not found, or not available to chat (outside this conversation\'s team or in a sensitive workspace)';

function outOfReach(): never {
  throw new Error(OUT_OF_REACH);
}

function ownerInReach(reach: ChatReach, owner: ChatObjectOwner | null): boolean {
  if (!owner) return false;
  if (owner.childWorkspaceIds?.some(id => !reach.workspaceIds.has(id))) return false;
  if (owner.workspaceId) return reach.workspaceIds.has(owner.workspaceId);
  return owner.teamId === reach.teamId;
}

/** Id-addressed routes → the object kind whose owner decides reach. */
const ID_OWNER: Record<string, 'task' | 'mission' | 'initiative'> = {
  '/api/tasks/:id': 'task',
  '/api/missions/:id': 'mission',
  '/api/missions/:id/evaluate': 'mission',
  '/api/initiatives/:id/artifacts': 'initiative',
};

/** Before dispatch: refuse out-of-reach targets, pin team-wide calls to the team. */
async function guardRequest(
  reach: ChatReach,
  method: string,
  url: URL,
  entry: RouteEntry,
  params: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const qWs = url.searchParams.get('workspaceId');
  if (qWs && !reach.workspaceIds.has(qWs)) outOfReach();
  const qTeam = url.searchParams.get('teamId');
  if (qTeam && qTeam !== reach.teamId) outOfReach();

  if (entry.pattern.startsWith('/api/workspaces/:id') && !reach.workspaceIds.has(params.id)) outOfReach();

  const kind = ID_OWNER[entry.pattern];
  if (kind && !ownerInReach(reach, await reach.ownerOf(kind, params.id))) outOfReach();

  if (entry.pattern === '/api/missions' && method === 'GET') url.searchParams.set('teamId', reach.teamId);

  if (entry.pattern === '/api/missions' && method === 'POST') {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(String(body ?? '{}')); } catch { outOfReach(); }
    if (!parsed || typeof parsed !== 'object') outOfReach();
    if (parsed.teamId != null && parsed.teamId !== reach.teamId) outOfReach();
    if (parsed.workspaceId != null && !reach.workspaceIds.has(String(parsed.workspaceId))) outOfReach();
    return JSON.stringify({ ...parsed, teamId: reach.teamId });
  }
  return body;
}

function rowInReach(reach: ChatReach, row: unknown, isWorkspaceList: boolean): boolean {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return true;
  const r = row as Record<string, unknown>;
  if (isWorkspaceList && typeof r.id === 'string' && !reach.workspaceIds.has(r.id)) return false;
  if (typeof r.workspaceId === 'string' && !reach.workspaceIds.has(r.workspaceId)) return false;
  const ws = r.workspace as { id?: unknown } | null | undefined;
  if (ws && typeof ws === 'object' && typeof ws.id === 'string' && !reach.workspaceIds.has(ws.id)) return false;
  if (typeof r.teamId === 'string' && r.teamId !== reach.teamId) return false;
  return true;
}

/** Drop out-of-reach rows at every depth. */
function filterInReach(reach: ChatReach, value: unknown, depth = 0, key = ''): unknown {
  if (depth > 8 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value
      .filter(v => rowInReach(reach, v, depth === 1 && key === 'workspaces'))
      .map(v => filterInReach(reach, v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = filterInReach(reach, v, depth + 1, k);
  return out;
}

/** After dispatch: a single object outside reach is refused; lists are filtered. */
function guardResponse(reach: ChatReach, body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body) && !rowInReach(reach, body, false)) outOfReach();
  return filterInReach(reach, body);
}

export interface ApiCall {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

/**
 * @param origin  the chat request's origin, for building absolute URLs
 * @param headers the chat request's session cookie is forwarded; an
 *                Authorization header never is, so a route that prefers a
 *                bearer key can't act as anyone but the signed-in user
 * @param onCall  sees every call and its parsed JSON (used to derive object refs)
 * @param reach   what this conversation's tools may touch (see ChatReach)
 */
export function createInProcessApi(opts: {
  origin: string;
  headers: Headers;
  onCall?: (call: ApiCall) => void;
  routes?: readonly RouteEntry[];
  reach?: ChatReach;
}): ApiFn {
  return async (endpoint, options = {}) => {
    const method = (options.method ?? 'GET').toUpperCase();
    const url = new URL(endpoint, opts.origin);
    const match = matchChatRoute(method, url.pathname, opts.routes);
    if (!match) throw new Error(`API error: 403 - ${method} ${url.pathname} is not available from chat`);

    const reqBody = opts.reach
      ? await guardRequest(opts.reach, method, url, match.entry, match.params, options.body)
      : options.body;

    const mod = await match.entry.load();
    const handler = mod[method] as Handler | undefined;
    if (typeof handler !== 'function') throw new Error(`API error: 405 - ${method} ${url.pathname}`);

    const headers = new Headers();
    for (const name of ['cookie', 'user-agent']) {
      const v = opts.headers.get(name);
      if (v) headers.set(name, v);
    }
    headers.set('content-type', 'application/json');
    const req = new NextRequest(url, {
      method,
      headers,
      ...(reqBody !== undefined && method !== 'GET' ? { body: reqBody as BodyInit } : {}),
    });

    const res = await handler(req, { params: Promise.resolve(match.params) });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (res.ok && opts.reach) body = guardResponse(opts.reach, body);
    opts.onCall?.({ method, path: url.pathname, status: res.status, body });
    if (!res.ok) throw new Error(`API error: ${res.status} - ${typeof body === 'string' ? body : text.slice(0, 500)}`);
    return body;
  };
}
