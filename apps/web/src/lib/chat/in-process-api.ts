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
 * Only the routes the chat tool allowlist needs are reachable, and each one
 * declares how it maps to the conversation's reach (reach-rules.ts). Anything
 * else is refused before dispatch, so a tool can't wander onto a write route.
 */

import { NextRequest } from 'next/server';
import type { ApiFn } from '@buildd/core/mcp-tools';
import { SCOPE_FIELDS, type OwnedKind, type RouteReach, type ScopeClaim } from './reach-rules';

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteModule = Record<string, unknown>;

export interface RouteEntry {
  /** Path pattern with `:param` segments, matching the app/api folder names. */
  pattern: string;
  methods: readonly string[];
  load: () => Promise<RouteModule>;
  /** How requests and responses map to the conversation's reach (reach-rules.ts). */
  reach: RouteReach;
}

const ROWS = { result: 'rows' } as const;

/** The whole reachable surface. Adding a chat tool means adding its routes here. */
export const CHAT_ROUTES: readonly RouteEntry[] = [
  {
    pattern: '/api/tasks', methods: ['GET'], load: () => import('@/app/api/tasks/route'),
    reach: { unpinned: 'lists the caller\'s tasks; every row carries its workspaceId and is filtered', ...ROWS },
  },
  { pattern: '/api/tasks/:id', methods: ['GET'], load: () => import('@/app/api/tasks/[id]/route'), reach: { path: [{ param: 'id', is: 'task' }], ...ROWS } },
  // POST is mission creation — reached only through an approved approval card.
  { pattern: '/api/missions', methods: ['GET', 'POST'], load: () => import('@/app/api/missions/route'), reach: { pinTeam: true, ...ROWS } },
  { pattern: '/api/missions/:id', methods: ['GET'], load: () => import('@/app/api/missions/[id]/route'), reach: { path: [{ param: 'id', is: 'mission' }], ...ROWS } },
  { pattern: '/api/missions/:id/evaluate', methods: ['GET'], load: () => import('@/app/api/missions/[id]/evaluate/route'), reach: { path: [{ param: 'id', is: 'mission' }], ...ROWS } },
  {
    pattern: '/api/workspaces', methods: ['GET'], load: () => import('@/app/api/workspaces/route'),
    reach: { unpinned: 'lists the caller\'s workspaces; every row is filtered by its own id', ...ROWS },
  },
  { pattern: '/api/workspaces/:id/schedules', methods: ['GET'], load: () => import('@/app/api/workspaces/[id]/schedules/route'), reach: { path: [{ param: 'id', is: 'workspace' }], ...ROWS } },
  {
    pattern: '/api/workspaces/:id/schedules/:scheduleId',
    methods: ['GET'],
    load: () => import('@/app/api/workspaces/[id]/schedules/[scheduleId]/route'),
    reach: { path: [{ param: 'id', is: 'workspace' }, { param: 'scheduleId', is: 'schedule' }], ...ROWS },
  },
  { pattern: '/api/workspaces/:id/artifacts', methods: ['GET'], load: () => import('@/app/api/workspaces/[id]/artifacts/route'), reach: { path: [{ param: 'id', is: 'workspace' }], ...ROWS } },
  { pattern: '/api/initiatives/:id/artifacts', methods: ['GET'], load: () => import('@/app/api/initiatives/[id]/artifacts/route'), reach: { path: [{ param: 'id', is: 'initiative' }], ...ROWS } },
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
  ownerOf: (kind: OwnedKind, id: string) => Promise<ChatObjectOwner | null>;
}

export interface ChatObjectOwner {
  teamId: string | null;
  workspaceId: string | null;
  /** Workspaces of the object's children (a mission's tasks); all must be in reach. */
  childWorkspaceIds?: readonly string[];
}

export const OUT_OF_REACH = 'API error: 404 - Not found, or not available to chat (outside this conversation\'s team or in a sensitive workspace)';

function outOfReach(): never {
  throw new Error(OUT_OF_REACH);
}

export function ownerInReach(reach: ChatReach, owner: ChatObjectOwner | null): boolean {
  if (!owner) return false;
  if (owner.childWorkspaceIds?.some(id => !reach.workspaceIds.has(id))) return false;
  if (owner.workspaceId) return reach.workspaceIds.has(owner.workspaceId);
  return owner.teamId === reach.teamId;
}

/** Is one scope claim inside reach? Unknown ids are out. */
export async function claimInReach(reach: ChatReach, claim: ScopeClaim): Promise<boolean> {
  if ('workspaceId' in claim) return reach.workspaceIds.has(claim.workspaceId);
  if ('teamId' in claim) return claim.teamId === reach.teamId;
  return ownerInReach(reach, await reach.ownerOf(claim.kind, claim.id));
}

/** The claims a scope field's value makes (`dependsOn: [a, b]` makes two). */
export function claimsForField(field: string, value: unknown): ScopeClaim[] | 'invalid' {
  const kind = SCOPE_FIELDS[field];
  if (!kind || value === undefined || value === null || value === '') return [];
  if (kind === 'task[]') {
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) return 'invalid';
    return (value as string[]).map(id => ({ kind: 'task' as const, id }));
  }
  if (typeof value !== 'string') return 'invalid';
  if (kind === 'workspace') return [{ workspaceId: value }];
  if (kind === 'team') return [{ teamId: value }];
  return [{ kind, id: value }];
}

async function assertFieldsInReach(reach: ChatReach, fields: Iterable<[string, unknown]>): Promise<void> {
  for (const [k, v] of fields) {
    const claims = claimsForField(k, v);
    if (claims === 'invalid') outOfReach();
    for (const c of claims) if (!(await claimInReach(reach, c))) outOfReach();
  }
}

/** Before dispatch: refuse out-of-reach targets, pin team-wide calls to the team. */
async function guardRequest(
  reach: ChatReach,
  method: string,
  url: URL,
  entry: RouteEntry,
  params: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const r = entry.reach;
  // Any scope field in the query, whatever the route.
  await assertFieldsInReach(reach, url.searchParams.entries());

  for (const t of r.path ?? []) {
    const id = params[t.param];
    const claim: ScopeClaim = t.is === 'workspace' ? { workspaceId: id } : { kind: t.is, id };
    if (!id || !(await claimInReach(reach, claim))) outOfReach();
  }

  if (r.requireQuery?.length && !r.path?.length && !r.pinTeam && !r.requireQuery.some(q => url.searchParams.get(q))) {
    throw new Error(`API error: 400 - from chat, ${url.pathname} needs ${r.requireQuery.join(' or ')}`);
  }

  if (method === 'GET') {
    if (r.pinTeam) url.searchParams.set('teamId', reach.teamId);
    return body;
  }

  let parsed: Record<string, unknown> = {};
  if (body !== undefined && body !== null && body !== '') {
    try { parsed = JSON.parse(String(body)); } catch { outOfReach(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) outOfReach();
  }
  await assertFieldsInReach(reach, Object.entries(parsed));
  return r.pinTeam ? JSON.stringify({ ...parsed, teamId: reach.teamId }) : body;
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

/** After dispatch: declared claims must be in reach; a foreign single object is refused; lists are filtered. */
async function guardResponse(reach: ChatReach, entry: RouteEntry, body: unknown): Promise<unknown> {
  if (typeof entry.reach.result === 'function') {
    for (const c of entry.reach.result(body)) if (!(await claimInReach(reach, c))) outOfReach();
  }
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
    if (res.ok && opts.reach) body = await guardResponse(opts.reach, match.entry, body);
    opts.onCall?.({ method, path: url.pathname, status: res.status, body });
    if (!res.ok) throw new Error(`API error: ${res.status} - ${typeof body === 'string' ? body : text.slice(0, 500)}`);
    return body;
  };
}
