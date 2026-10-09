/**
 * An `ApiFn` for the MCP action handlers that calls buildd's own route
 * handlers in-process, as the signed-in user.
 *
 * Chat tools reuse `handleBuilddAction` from packages/core/mcp-tools.ts, which
 * reaches the platform through REST routes. `/api/mcp` hands it an HTTP client
 * with a bearer token. Chat doesn't: a second HTTP hop and a minted token per
 * turn are exactly what knowledge-base: buildd/design/agent-chat.md rules out. Instead each
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
import { SCOPE_FIELDS, type OwnedKind, type PathTarget, type RouteReach, type ScopeClaim } from './reach-rules';

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

/**
 * The whole reachable surface. Adding a chat tool means adding its routes here
 * (with a reach declaration — reach-rules.test.ts fails otherwise) and naming
 * them in the op's `routes` in registry.ts. Write methods are listed here, but
 * a call only gets the routes its own op declares, and write ops only run
 * after an approval card this request won.
 */
const path = (...p: Array<[string, PathTarget['is']]>) => p.map(([param, is]) => ({ param, is }));
const byTask = { path: path(['id', 'task']), ...ROWS };
const byMission = { path: path(['id', 'mission']), ...ROWS };
const byWorkspace = { path: path(['id', 'workspace']), ...ROWS };
const byWorker = { path: path(['id', 'worker']), ...ROWS };

export const CHAT_ROUTES: readonly RouteEntry[] = [
  // ── tasks ──
  {
    pattern: '/api/tasks', methods: ['GET', 'POST'], load: () => import('@/app/api/tasks/route'),
    reach: { unpinned: 'lists the caller\'s tasks; every row carries its workspaceId and is filtered', requireBody: ['workspaceId'], ...ROWS },
  },
  { pattern: '/api/tasks/:id', methods: ['GET', 'PATCH'], load: () => import('@/app/api/tasks/[id]/route'), reach: byTask },
  { pattern: '/api/tasks/:id/error-traces', methods: ['GET'], load: () => import('@/app/api/tasks/[id]/error-traces/route'), reach: byTask },
  { pattern: '/api/tasks/:id/messages', methods: ['GET'], load: () => import('@/app/api/tasks/[id]/messages/route'), reach: byTask },
  // evidenceId travels as a query param: OwnedKind has no evidence member, and the route checks it belongs to :id.
  { pattern: '/api/tasks/:id/evidence', methods: ['GET'], load: () => import('@/app/api/tasks/[id]/evidence/route'), reach: byTask },
  { pattern: '/api/evidence', methods: ['GET'], load: () => import('@/app/api/evidence/route'), reach: { requireQuery: ['workspaceId'], ...ROWS } },
  { pattern: '/api/tasks/:id/notes', methods: ['POST'], load: () => import('@/app/api/tasks/[id]/notes/route'), reach: byTask },
  { pattern: '/api/tasks/:id/approve-plan', methods: ['POST'], load: () => import('@/app/api/tasks/[id]/approve-plan/route'), reach: byTask },
  { pattern: '/api/tasks/:id/reject-plan', methods: ['POST'], load: () => import('@/app/api/tasks/[id]/reject-plan/route'), reach: byTask },
  { pattern: '/api/tasks/:id/attach-pr', methods: ['POST'], load: () => import('@/app/api/tasks/[id]/attach-pr/route'), reach: byTask },

  // ── missions and initiatives ──
  { pattern: '/api/missions', methods: ['GET', 'POST'], load: () => import('@/app/api/missions/route'), reach: { pinTeam: true, ...ROWS } },
  {
    pattern: '/api/missions/capabilities', methods: ['GET'], load: () => import('@/app/api/missions/capabilities/route'),
    reach: { unpinned: 'a static list of mission controls this server supports; no team data', ...ROWS },
  },
  { pattern: '/api/missions/:id', methods: ['GET', 'PATCH', 'DELETE'], load: () => import('@/app/api/missions/[id]/route'), reach: byMission },
  { pattern: '/api/missions/:id/evaluate', methods: ['GET', 'POST'], load: () => import('@/app/api/missions/[id]/evaluate/route'), reach: byMission },
  { pattern: '/api/missions/:id/notes', methods: ['POST'], load: () => import('@/app/api/missions/[id]/notes/route'), reach: byMission },
  { pattern: '/api/missions/:id/link', methods: ['POST'], load: () => import('@/app/api/missions/[id]/link/route'), reach: byMission },
  { pattern: '/api/missions/:id/artifacts', methods: ['GET', 'POST'], load: () => import('@/app/api/missions/[id]/artifacts/route'), reach: byMission },
  // The visual review read (get_visual_review). GET only: the decisions routes
  // under it are never listed here, so no assistant tool can reach them.
  { pattern: '/api/missions/:id/visual-review', methods: ['GET'], load: () => import('@/app/api/missions/[id]/visual-review/route'), reach: byMission },
  { pattern: '/api/initiatives', methods: ['GET', 'POST'], load: () => import('@/app/api/initiatives/route'), reach: { pinTeam: true, ...ROWS } },
  { pattern: '/api/initiatives/:id', methods: ['GET', 'PATCH', 'DELETE'], load: () => import('@/app/api/initiatives/[id]/route'), reach: { path: path(['id', 'initiative']), ...ROWS } },
  { pattern: '/api/initiatives/:id/artifacts', methods: ['GET', 'POST'], load: () => import('@/app/api/initiatives/[id]/artifacts/route'), reach: { path: path(['id', 'initiative']), ...ROWS } },
  { pattern: '/api/discrepancies', methods: ['GET'], load: () => import('@/app/api/discrepancies/route'), reach: { requireQuery: ['workspaceId'], ...ROWS } },
  { pattern: '/api/discrepancies/:id', methods: ['GET'], load: () => import('@/app/api/discrepancies/[id]/route'), reach: { path: path(['id', 'discrepancy']), ...ROWS } },
  { pattern: '/api/discrepancies/:id/adjudicate', methods: ['POST'], load: () => import('@/app/api/discrepancies/[id]/adjudicate/route'), reach: { path: path(['id', 'discrepancy']), ...ROWS } },
  { pattern: '/api/discrepancies/:id/promote', methods: ['POST'], load: () => import('@/app/api/discrepancies/[id]/promote/route'), reach: { path: path(['id', 'discrepancy']), ...ROWS } },

  // ── workers ──
  // Before /api/workers/:id, which would take "active" as a worker id.
  {
    pattern: '/api/workers/active', methods: ['GET'], load: () => import('@/app/api/workers/active/route'),
    reach: { unpinned: 'lists the runners serving the caller\'s workspaces; every row carries its workspaceIds, and a row is kept only for the ones in reach (the rest are stripped)', ...ROWS },
  },
  { pattern: '/api/workers/:id', methods: ['GET'], load: () => import('@/app/api/workers/[id]/route'), reach: byWorker },
  { pattern: '/api/workers/:id/instruct', methods: ['POST'], load: () => import('@/app/api/workers/[id]/instruct/route'), reach: byWorker },
  { pattern: '/api/workers/:id/respond', methods: ['POST'], load: () => import('@/app/api/workers/[id]/respond/route'), reach: byWorker },
  // Team-wide reads: the route limits results to ?teamId (session path), which the guard pins.
  { pattern: '/api/explain', methods: ['GET'], load: () => import('@/app/api/explain/route'), reach: { pinTeam: true, ...ROWS } },
  { pattern: '/api/health/failures', methods: ['GET'], load: () => import('@/app/api/health/failures/route'), reach: { pinTeam: true, ...ROWS } },
  { pattern: '/api/health/budget', methods: ['GET'], load: () => import('@/app/api/health/budget/route'), reach: { pinTeam: true, ...ROWS } },
  { pattern: '/api/connectors/mounted', methods: ['GET'], load: () => import('@/app/api/connectors/mounted/route'), reach: { requireQuery: ['workspaceId'], ...ROWS } },

  // ── PRs and releases ──
  {
    pattern: '/api/prs', methods: ['GET'], load: () => import('@/app/api/prs/route'),
    reach: { unpinned: 'lists the caller\'s PRs; every row carries its workspaceId and is filtered', ...ROWS },
  },
  { pattern: '/api/github/pr', methods: ['GET'], load: () => import('@/app/api/github/pr/route'), reach: { pinTeam: true, requireQuery: ['workerId', 'workspaceId'], ...ROWS } },
  // merge_pr from chat: the dashboard's merge route, as the signed-in person; the workspace names the repo.
  { pattern: '/api/prs/:prNumber/merge', methods: ['POST'], load: () => import('@/app/api/prs/[prNumber]/merge/route'), reach: { requireBody: ['workspaceId'], bodyScopedPath: ['prNumber'], ...ROWS } },
  { pattern: '/api/github/pr/review', methods: ['GET'], load: () => import('@/app/api/github/pr/review/route'), reach: { pinTeam: true, ...ROWS } },
  { pattern: '/api/releases', methods: ['GET'], load: () => import('@/app/api/releases/route'), reach: { requireQuery: ['workspaceId', 'missionId'], ...ROWS } },
  { pattern: '/api/releases/status', methods: ['GET'], load: () => import('@/app/api/releases/status/route'), reach: { requireQuery: ['workspaceId'], ...ROWS } },
  { pattern: '/api/releases/trigger', methods: ['POST'], load: () => import('@/app/api/releases/trigger/route'), reach: { requireBody: ['workspaceId'], ...ROWS } },
  { pattern: '/api/releases/:id', methods: ['GET'], load: () => import('@/app/api/releases/[id]/route'), reach: { path: path(['id', 'release']), ...ROWS } },

  // ── workspaces, schedules, artifacts, skills ──
  {
    pattern: '/api/workspaces', methods: ['GET', 'POST'], load: () => import('@/app/api/workspaces/route'),
    reach: { pinTeam: true, ...ROWS },
  },
  { pattern: '/api/workspaces/:id', methods: ['PATCH'], load: () => import('@/app/api/workspaces/[id]/route'), reach: byWorkspace },
  { pattern: '/api/workspaces/:id/config', methods: ['GET', 'POST'], load: () => import('@/app/api/workspaces/[id]/config/route'), reach: byWorkspace },
  { pattern: '/api/workspaces/:id/create-repo', methods: ['POST'], load: () => import('@/app/api/workspaces/[id]/create-repo/route'), reach: byWorkspace },
  { pattern: '/api/workspaces/:id/policy-init', methods: ['POST'], load: () => import('@/app/api/workspaces/[id]/policy-init/route'), reach: byWorkspace },
  { pattern: '/api/workspaces/:id/error-traces', methods: ['GET'], load: () => import('@/app/api/workspaces/[id]/error-traces/route'), reach: byWorkspace },
  { pattern: '/api/workspaces/:id/schedules', methods: ['GET', 'POST'], load: () => import('@/app/api/workspaces/[id]/schedules/route'), reach: byWorkspace },
  {
    pattern: '/api/workspaces/:id/schedules/:scheduleId',
    methods: ['GET', 'PATCH', 'DELETE'],
    load: () => import('@/app/api/workspaces/[id]/schedules/[scheduleId]/route'),
    reach: { path: path(['id', 'workspace'], ['scheduleId', 'schedule']), ...ROWS },
  },
  { pattern: '/api/workspaces/:id/artifacts', methods: ['GET'], load: () => import('@/app/api/workspaces/[id]/artifacts/route'), reach: byWorkspace },
  { pattern: '/api/artifacts/:artifactId', methods: ['GET'], load: () => import('@/app/api/artifacts/[artifactId]/route'), reach: { path: path(['artifactId', 'artifact']), ...ROWS } },
  { pattern: '/api/workspaces/:id/skills', methods: ['GET', 'POST'], load: () => import('@/app/api/workspaces/[id]/skills/route'), reach: byWorkspace },
  {
    pattern: '/api/workspaces/:id/skills/:skillId', methods: ['GET', 'PATCH', 'DELETE'],
    load: () => import('@/app/api/workspaces/[id]/skills/[skillId]/route'),
    reach: { path: path(['id', 'workspace'], ['skillId', 'skill']), ...ROWS },
  },
  { pattern: '/api/workspaces/:id/watched-projects', methods: ['GET', 'POST'], load: () => import('@/app/api/workspaces/[id]/watched-projects/route'), reach: byWorkspace },
  { pattern: '/api/watched-projects/:id', methods: ['PATCH', 'DELETE'], load: () => import('@/app/api/watched-projects/[id]/route'), reach: { path: path(['id', 'watched_project']), ...ROWS } },
  { pattern: '/api/watched-projects/:id/run', methods: ['POST'], load: () => import('@/app/api/watched-projects/[id]/run/route'), reach: { path: path(['id', 'watched_project']), ...ROWS } },

  // ── watches (the caller's own subscriptions) ──
  {
    pattern: '/api/subscriptions', methods: ['GET', 'POST'], load: () => import('@/app/api/subscriptions/route'),
    reach: {
      unpinned: 'lists only the caller\'s own watches; every row carries its teamId and workspaceId and is filtered',
      requireBody: ['taskId', 'workspaceId'],
      ...ROWS,
    },
  },
  { pattern: '/api/subscriptions/:id', methods: ['DELETE'], load: () => import('@/app/api/subscriptions/[id]/route'), reach: { path: path(['id', 'subscription']), ...ROWS } },

  // ── experiments ──
  { pattern: '/api/experiments', methods: ['GET', 'POST'], load: () => import('@/app/api/experiments/route'), reach: { requireQuery: ['workspaceId'], ...ROWS } },
  { pattern: '/api/experiments/:id', methods: ['GET', 'PATCH'], load: () => import('@/app/api/experiments/[id]/route'), reach: { path: path(['id', 'experiment']), ...ROWS } },
  { pattern: '/api/experiments/:id/readout', methods: ['GET'], load: () => import('@/app/api/experiments/[id]/readout/route'), reach: { path: path(['id', 'experiment']), ...ROWS } },

  // ── evidence storage (reads only: the writes stay on the Storage settings screen) ──
  { pattern: '/api/evidence-backends', methods: ['GET'], load: () => import('@/app/api/evidence-backends/route'), reach: { requireQuery: ['workspaceId'], ...ROWS } },
  { pattern: '/api/evidence-backends/:id', methods: ['GET'], load: () => import('@/app/api/evidence-backends/[id]/route'), reach: { path: path(['id', 'evidence_backend']), ...ROWS } },
];

/** Every GET in CHAT_ROUTES and nothing else: what previews and the docked object read through. */
export function chatReadRoutes(routes: readonly RouteEntry[] = CHAT_ROUTES): RouteEntry[] {
  return routes.filter(r => r.methods.includes('GET')).map(r => ({ ...r, methods: ['GET'] }));
}

/** A copy of the routes narrowed to exactly the `METHOD /pattern` refs an op declares. */
export function routesFor(refs: readonly string[], routes: readonly RouteEntry[] = CHAT_ROUTES): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const r of routes) {
    const methods = r.methods.filter(m => refs.includes(`${m} ${r.pattern}`));
    if (methods.length) out.push({ ...r, methods });
  }
  return out;
}

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
  if (entry.pattern === '/api/tasks' && method === 'POST') {
    // A task filed from chat: a person asked for it in the dashboard, never a
    // worker, and never with a callback that reports outside buildd.
    const ctx = parsed.context as Record<string, unknown> | undefined;
    if (parsed.parentTaskId != null || parsed.createdByWorkerId != null || ctx?.callback != null) outOfReach();
    parsed = { ...parsed, creationSource: 'dashboard' };
    body = JSON.stringify(parsed);
  }
  const pinnedByRequest = (r.path?.length ?? 0) > 0 || r.pinTeam || (r.requireQuery ?? []).some(q => url.searchParams.get(q));
  if (!pinnedByRequest && r.requireBody?.length && !r.requireBody.some(f => parsed[f] != null && parsed[f] !== '')) {
    throw new Error(`API error: 400 - from chat, ${method} ${url.pathname} needs ${r.requireBody.join(' or ')}`);
  }
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

/**
 * A row that serves several workspaces (a runner: `workspaceIds`, with
 * `workspaceNames` alongside) is kept with only the in-reach ones; with none
 * left it is out of reach. Other rows pass through.
 */
function narrowWorkspaceIds(reach: ChatReach, row: Record<string, unknown>): Record<string, unknown> | null {
  const ids = row.workspaceIds;
  if (!Array.isArray(ids)) return row;
  const keep = ids.map(id => typeof id === 'string' && reach.workspaceIds.has(id));
  if (!keep.some(Boolean)) return null;
  const out: Record<string, unknown> = { ...row, workspaceIds: ids.filter((_, i) => keep[i]) };
  const names = row.workspaceNames;
  if (Array.isArray(names)) out.workspaceNames = names.length === ids.length ? names.filter((_, i) => keep[i]) : [];
  return out;
}

/** filterInReach's mark for an object that is out of reach once narrowed. */
const OUT = Symbol('out-of-reach');

/** Drop out-of-reach rows at every depth; OUT when the value itself is out. */
function filterInReach(reach: ChatReach, value: unknown, depth = 0, key = ''): unknown {
  if (depth > 8 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value
      .filter(v => rowInReach(reach, v, depth === 1 && key === 'workspaces'))
      .map(v => filterInReach(reach, v, depth + 1))
      .filter(v => v !== OUT);
  }
  const row = narrowWorkspaceIds(reach, value as Record<string, unknown>);
  if (!row) return OUT;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const kept = filterInReach(reach, v, depth + 1, k);
    if (kept !== OUT) out[k] = kept;
  }
  return out;
}


/** After dispatch: declared claims must be in reach; a foreign single object is refused; lists are filtered. */
async function guardResponse(reach: ChatReach, entry: RouteEntry, body: unknown): Promise<unknown> {
  if (typeof entry.reach.result === 'function') {
    for (const c of entry.reach.result(body)) if (!(await claimInReach(reach, c))) outOfReach();
  }
  if (body && typeof body === 'object' && !Array.isArray(body) && !rowInReach(reach, body, false)) outOfReach();
  const kept = filterInReach(reach, body);
  if (kept === OUT) outOfReach();
  return kept;
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
