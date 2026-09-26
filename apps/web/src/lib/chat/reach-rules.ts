/**
 * Reach declarations for the chat's in-process routes (docs/design/agent-chat.md
 * → Tools and permissions → Reach).
 *
 * A chat tool reaches data only through the routes in CHAT_ROUTES
 * (in-process-api.ts). Every one of those routes declares, here, how a request
 * and its response map to a workspace or team, so the guard never has to guess
 * from field names alone:
 *
 *   - `path`: which path params name the target (a workspace, or an object
 *     whose owner decides reach);
 *   - `pinTeam`: a team-wide route; the guard sets `teamId` to the
 *     conversation team, and the route must honour it;
 *   - `requireQuery`: a route addressed only by query; at least one of these
 *     params must be present and in reach, or the call is refused;
 *   - `unpinned`: a GET with no request-side pin, whose every response row
 *     carries its own scope and is filtered (a list of the caller's
 *     workspaces), or which returns no team data at all; with the reason;
 *   - `result`: how the response is checked after dispatch.
 *
 * On top of the declaration, SCOPE_FIELDS are always checked wherever they
 * appear in a query string or a JSON body: a `missionId` in a PATCH body is a
 * mission that must be in reach, whatever route it's sent to.
 *
 * `routeReachProblems` is the CI guard: a route with no way to pin its scope
 * fails the test suite instead of reaching everything.
 */

export type OwnedKind =
  | 'task' | 'mission' | 'initiative' | 'worker' | 'artifact' | 'schedule' | 'skill'
  | 'watched_project' | 'discrepancy' | 'experiment';

export type PathTarget = { param: string; is: 'workspace' | OwnedKind };

/** A scope the response claims: a workspace, a team, or an object to look up. */
export type ScopeClaim =
  | { workspaceId: string }
  | { teamId: string }
  | { kind: OwnedKind; id: string };

export interface RouteReach {
  path?: readonly PathTarget[];
  pinTeam?: boolean;
  requireQuery?: readonly string[];
  /** Why this GET needs no request-side pin (rows self-scoped, or no team data). */
  unpinned?: string;
  /**
   * 'rows': drop list rows outside reach and refuse a single object that names
   * a foreign scope (the generic field check). A function: the scopes the
   * response claims; any claim outside reach refuses the whole response.
   */
  result: 'rows' | ((body: unknown) => ScopeClaim[]);
}

/**
 * Fields that name a scoped object wherever they appear (query or body).
 * `team` is checked against the conversation team; the rest through reach.
 */
export const SCOPE_FIELDS: Readonly<Record<string, 'workspace' | 'team' | OwnedKind | 'task[]'>> = {
  workspaceId: 'workspace',
  teamId: 'team',
  taskId: 'task',
  parentTaskId: 'task',
  dependsOn: 'task[]',
  missionId: 'mission',
  dependsOnMission: 'mission',
  initiativeId: 'initiative',
  workerId: 'worker',
  artifactId: 'artifact',
};

/** CI guard: problems with one route's declaration (empty = fine). */
export function routeReachProblems(route: { pattern: string; methods: readonly string[]; reach?: RouteReach }): string[] {
  const out: string[] = [];
  const r = route.reach;
  if (!r) return [`${route.pattern}: no reach declaration`];
  const params = route.pattern.split('/').filter(s => s.startsWith(':')).map(s => s.slice(1));
  for (const p of params) {
    if (!r.path?.some(t => t.param === p)) out.push(`${route.pattern}: path param :${p} has no reach target`);
  }
  for (const t of r.path ?? []) {
    if (!params.includes(t.param)) out.push(`${route.pattern}: reach names :${t.param}, which the pattern lacks`);
  }
  const pinned = (r.path?.length ?? 0) > 0 || r.pinTeam || (r.requireQuery?.length ?? 0) > 0;
  if (!pinned && !r.unpinned) {
    out.push(`${route.pattern}: nothing pins its scope (declare path, pinTeam, requireQuery, or unpinned with a reason)`);
  }
  if (r.unpinned !== undefined && r.unpinned.trim().length < 10) out.push(`${route.pattern}: unpinned needs a reason`);
  if (r.unpinned && route.methods.some(m => m !== 'GET')) out.push(`${route.pattern}: a write route can't be unpinned`);
  return out;
}
