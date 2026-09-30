import { hasTokenScope, type TokenScope } from '@buildd/core/token-scopes';

/** One capability map for REST authentication and legacy administrator gates. */
export function requiredTokenScope(pathname: string, method: string): TokenScope | null {
  const path = pathname.replace(/\/$/, '');
  const read = method === 'GET' || method === 'HEAD';
  if (/^\/api\/experiments(?:\/|$)/.test(path)) return read ? 'analytics:read' : 'admin';
  if (/^\/api\/tasks\/[^/]+\/(approve-plan|reject-plan)$/.test(path)) return 'tasks:admin';
  if (/^\/api\/workers\/[^/]+\/instruct$/.test(path)) return 'workers:admin';
  if (/^\/api\/workspaces\/[^/]+\/memory(?:\/|$)/.test(path) && method === 'DELETE') return 'knowledge:admin';
  if (/^\/api\/(stats|health|cbm)(\/|$)/.test(path)) return read ? 'analytics:read' : 'admin';
  if (/^\/api\/releases(\/|$)/.test(path)) return 'releases';
  if (/^\/api\/secrets(\/|$)/.test(path) || /^\/api\/cloudflare\/credential/.test(path)) return 'secrets';
  if (/^\/api\/runner\/credential-(lease|refresh)$/.test(path)) return 'secrets';
  if (/^\/api\/runner(\/|$)/.test(path) || /\/codex-credential\//.test(path)) return 'workers:write';
  if (/^\/api\/knowledge(\/|$)/.test(path)) return read ? 'tasks:read' : 'knowledge:write';
  if (/^\/api\/workspaces\/[^/]+\/(skills|backends)(\/|$)/.test(path) || path === '/api/roles') return read ? 'tasks:read' : 'skills:admin';
  if (/^\/api\/workspaces\/[^/]+\/schedules(\/|$)/.test(path)) return read ? 'tasks:read' : 'schedules:write';
  if (/^\/api\/workspaces\/[^/]+\/(memory|knowledge-health)(\/|$)/.test(path)) return read ? 'tasks:read' : 'knowledge:write';
  if (/^\/api\/workspaces\/[^/]+\/error-traces$/.test(path)) return 'analytics:read';
  if (/^\/api\/workspaces(\/|$)/.test(path)) return read ? 'tasks:read' : 'workspaces:admin';
  if (/^\/api\/watched-projects(\/|$)/.test(path)) return 'workspaces:admin';
  if (/^\/api\/discrepancies\/[^/]+\/(adjudicate|promote)$/.test(path)) return 'missions:admin';
  if (/^\/api\/(missions|initiatives)(\/|$)/.test(path)) return read ? 'tasks:read' : 'missions:admin';
  if (path === '/api/workers/active') return 'analytics:read';
  if (/^\/api\/workers\/[^/]+\/error-traces$/.test(path)) return 'analytics:read';
  if (path === '/api/explain' || (read && /^\/api\/connectors(\/|$)/.test(path))) return 'analytics:read';
  if (/^\/api\/workers(\/|$)/.test(path)) return read ? 'tasks:read' : 'workers:write';
  if (/^\/api\/(tasks|discrepancies|artifacts|attachments|prs)(\/|$)/.test(path)) return read ? 'tasks:read' : 'tasks:write';
  if (/^\/api\/github\/pr(\/|$)/.test(path) || path === '/api/webhooks/ingest') return 'tasks:write';
  if (path === '/api/accounts/me') return 'tasks:read';
  if (/^\/api\/(accounts|connectors|model-tiers|explain)(\/|$)/.test(path)) return 'admin';
  return 'admin';
}

type ScopedToken = { scopes?: readonly string[] | null; workspaceIds?: readonly string[] | null };
type RouteRequest = { url: string; method: string };

export function canAccessTokenRoute(token: ScopedToken, request?: RouteRequest): boolean {
  if (token.scopes == null) return true;
  if (!request) return false;
  const url = new URL(request.url);
  // MCP dispatch performs its own action and workspace checks after authentication.
  if (url.pathname === '/api/mcp' || /^\/api\/mcp-oauth\//.test(url.pathname)) return true;
  if (token.workspaceIds != null) {
    if (requiredTokenScope(url.pathname, request.method) === 'secrets' || requiredTokenScope(url.pathname, request.method) === 'admin') return false;
    if (/^\/api\/experiments(?:\/|$)/.test(url.pathname)) return false;
    if (/^\/api\/connectors(?:\/|$)/.test(url.pathname)) return false;
    if (/^\/api\/knowledge\/ingest-jobs$/.test(url.pathname) && !url.searchParams.get('workspaceId')) return false;
    if (/^\/api\/releases\/(status|trigger|readiness)$/.test(url.pathname) && !url.searchParams.get('workspaceId') && request.method === 'GET') return false;
    const pathWorkspace = /^\/api\/workspaces\/([^/]+)/.exec(url.pathname)?.[1];
    const queryWorkspace = url.searchParams.get('workspaceId') ?? url.searchParams.get('workspace');
    const queryWorkspaces = url.searchParams.get('workspaceIds')?.split(',').filter(Boolean);
    if (pathWorkspace && !['by-repo', 'match-repos'].includes(pathWorkspace) && !token.workspaceIds.includes(pathWorkspace)) return false;
    if (queryWorkspace && !token.workspaceIds.includes(queryWorkspace)) return false;
    if (queryWorkspaces?.some(id => !token.workspaceIds!.includes(id))) return false;
    // Only accept filters the endpoint actually applies. A decorative query
    // parameter must never turn a team-wide response into scoped authorization.
    if (/^\/api\/(stats|health|cbm)(\/|$)/.test(url.pathname)) {
      const filters: Record<string, string[]> = {
        '/api/stats/actions': ['workspace'], '/api/stats/usage': ['workspace'],
        '/api/stats/coordination': ['workspaceId', 'workspace'], '/api/health/failures': ['workspaceId'],
      };
      if (!filters[url.pathname]?.some(name => url.searchParams.get(name))) return false;
    }
    const unfilteredCollections = ['/api/workers/active', '/api/artifacts', '/api/workspaces', '/api/roles', '/api/connectors', '/api/connectors/mounted'];
    if (unfilteredCollections.includes(url.pathname)) return false;
    const filteredCollections = ['/api/tasks', '/api/missions', '/api/initiatives', '/api/prs', '/api/releases'];
    if ((request.method === 'GET' || request.method === 'HEAD') && filteredCollections.includes(url.pathname) && !url.searchParams.get('workspaceId')) return false;
  }
  const scope = requiredTokenScope(url.pathname, request.method);
  return scope !== null && hasTokenScope(token.scopes, scope);
}

/** Scoped tokens pass the matching capability instead of requiring admin level. */
export function hasTokenRouteAdminAccess(
  token: (ScopedToken & { level: string }) | null | undefined,
  request: RouteRequest,
): boolean {
  if (!token) return false;
  return token.scopes == null ? token.level === 'admin' : canAccessTokenRoute(token, request);
}
