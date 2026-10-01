import { describe, expect, test } from 'bun:test';
import { TOKEN_PRESETS, TOKEN_SCOPES, requiresTeamAdminToGrant } from '@buildd/core/token-scopes';
import { ADMIN_TIER_SCOPES, adminCapabilityForRoute, canAccessTokenRoute, hasTokenRouteAdminAccess, requiredTokenScope } from './token-route-policy';
const request = (path: string, method = 'GET') => ({ url: `https://example.test${path}`, method });
describe('REST token scope policy', () => {
  test('CI tokens can write tasks without admin and cannot read secrets', () => {
    const token = { level: 'worker', scopes: ['tasks:write'] };
    expect(canAccessTokenRoute(token, request('/api/tasks', 'POST'))).toBe(true);
    expect(hasTokenRouteAdminAccess(token, request('/api/tasks/bulk', 'POST'))).toBe(false);
    expect(canAccessTokenRoute(token, request('/api/secrets'))).toBe(false);
  });
  test('analytics readers can reach analytics only', () => {
    const token = { level: 'worker', scopes: ['analytics:read'] };
    for (const path of ['/api/stats/actions', '/api/stats/usage', '/api/health/failures', '/api/cbm/metrics']) {
      expect(canAccessTokenRoute(token, request(path))).toBe(true);
    }
    expect(canAccessTokenRoute(token, request('/api/tasks', 'POST'))).toBe(false);
  });
  test('explicit scopes override the legacy level and fail closed', () => {
    expect(canAccessTokenRoute({ scopes: [] }, request('/api/tasks'))).toBe(false);
    expect(hasTokenRouteAdminAccess({ level: 'admin', scopes: [] }, request('/api/secrets'))).toBe(false);
    expect(canAccessTokenRoute({ scopes: ['tasks:read'] }, request('/api/new-capability'))).toBe(false);
    expect(canAccessTokenRoute({ scopes: ['tasks:read'] })).toBe(false);
  });
  test('workspace restrictions reject other workspaces and unfiltered analytics', () => {
    const token = { scopes: ['analytics:read'], workspaceIds: ['ws-a'] };
    expect(canAccessTokenRoute(token, request('/api/stats/coordination'))).toBe(false);
    expect(canAccessTokenRoute(token, request('/api/stats/coordination?workspace=ws-b'))).toBe(false);
    expect(canAccessTokenRoute(token, request('/api/stats/coordination?workspace=ws-a'))).toBe(true);
    expect(canAccessTokenRoute(token, request('/api/health/budget?workspaceId=ws-a'))).toBe(false);
    expect(canAccessTokenRoute(token, request('/api/stats/actions?workspaceId=ws-a'))).toBe(false);
    expect(canAccessTokenRoute({ scopes: ['tasks:read'], workspaceIds: ['ws-a'] }, request('/api/tasks?workspace=ws-a'))).toBe(false);
    expect(canAccessTokenRoute({ scopes: ['admin'], workspaceIds: ['ws-a'] }, request('/api/artifacts?workspaceId=ws-a'))).toBe(false);
    expect(canAccessTokenRoute({ scopes: ['admin'], workspaceIds: ['ws-a'] }, request('/api/workspaces/ws-b/config', 'PATCH'))).toBe(false);
  });
  test('evidence reads take analytics:read, matching the read_evidence action', () => {
    const token = { scopes: ['analytics:read'] };
    expect(requiredTokenScope('/api/tasks/t-1/evidence', 'GET')).toBe('analytics:read');
    expect(requiredTokenScope('/api/evidence', 'GET')).toBe('analytics:read');
    expect(canAccessTokenRoute(token, request('/api/tasks/t-1/evidence?tail=50'))).toBe(true);
    expect(canAccessTokenRoute(token, request('/api/evidence?workspaceId=ws-a&prNumber=1'))).toBe(true);
    expect(canAccessTokenRoute({ scopes: ['tasks:read'] }, request('/api/tasks/t-1/evidence'))).toBe(false);
    // Downloads are session-only; writes are runner routes under workers:write.
    expect(canAccessTokenRoute(token, request('/api/evidence/download?taskId=t&evidenceId=e'))).toBe(false);
    expect(canAccessTokenRoute(token, request('/api/workers/w-1/evidence-upload-url', 'POST'))).toBe(false);
    expect(canAccessTokenRoute({ scopes: ['workers:write'] }, request('/api/workers/w-1/evidence-upload-url', 'POST'))).toBe(true);
    const restricted = { scopes: ['analytics:read'], workspaceIds: ['ws-a'] };
    expect(canAccessTokenRoute(restricted, request('/api/evidence?workspaceId=ws-b&prNumber=1'))).toBe(false);
    expect(canAccessTokenRoute(restricted, request('/api/evidence?workspaceId=ws-a&prNumber=1'))).toBe(true);
  });
  test('MCP transport defers to its action gate without requiring admin', () => {
    expect(canAccessTokenRoute({ scopes: ['analytics:read'] }, request('/api/mcp', 'POST'))).toBe(true);
  });
  test('legacy tokens retain existing authorization', () => {
    expect(canAccessTokenRoute({}, request('/api/new-capability'))).toBe(true);
    expect(hasTokenRouteAdminAccess({ level: 'admin' }, request('/api/secrets'))).toBe(true);
    expect(hasTokenRouteAdminAccess({ level: 'worker' }, request('/api/secrets'))).toBe(false);
  });
  test('nested workspace capabilities take precedence over workspace administration', () => {
    expect(requiredTokenScope('/api/workspaces/demo/skills', 'POST')).toBe('skills:admin');
    expect(requiredTokenScope('/api/workspaces/demo/schedules', 'POST')).toBe('schedules:write');
    expect(requiredTokenScope('/api/workspaces/demo/memory', 'POST')).toBe('knowledge:write');
  });
  test('an admin gate on an ordinary-scope route needs an explicit admin capability', () => {
    // The route's ordinary scope (what authentication already checked) never
    // doubles as the admin capability for a gate inside the handler.
    expect(adminCapabilityForRoute('/api/tasks/bulk', 'POST')).toBeNull();
    expect(adminCapabilityForRoute('/api/workers/claim', 'POST')).toBeNull();
    expect(adminCapabilityForRoute('/api/github/pr', 'PUT')).toBeNull();
    expect(adminCapabilityForRoute('/api/missions', 'POST')).toBe('missions:admin');
    const presets = [TOKEN_PRESETS.ci, TOKEN_PRESETS.runner];
    const gates: Array<[string, string, Parameters<typeof hasTokenRouteAdminAccess>[2]]> = [
      ['/api/github/pr', 'PUT', 'admin'],
      ['/api/workers/claim', 'POST', 'admin'],
      ['/api/tasks/bulk', 'POST', 'tasks:admin'],
      ['/api/tasks/cleanup', 'POST', 'tasks:admin'],
      ['/api/tasks/t1/attach-pr', 'POST', 'tasks:admin'],
      ['/api/discrepancies/d1/dispatch-doc-fix', 'POST', 'missions:admin'],
      ['/api/knowledge/ingest-jobs', 'POST', 'knowledge:admin'],
      ['/api/workers/w1/activity', 'POST', 'workers:admin'],
      ['/api/tasks/t1/messages', 'GET', 'workers:admin'],
    ];
    for (const preset of presets) {
      const token = { level: 'worker', scopes: preset.scopes };
      for (const [path, method, capability] of gates) {
        expect(hasTokenRouteAdminAccess(token, request(path, method), capability)).toBe(false);
        expect(hasTokenRouteAdminAccess(token, request(path, method))).toBe(false);
      }
    }
    expect(hasTokenRouteAdminAccess({ level: 'admin', scopes: ['admin'] }, request('/api/tasks/bulk', 'POST'), 'tasks:admin')).toBe(true);
    expect(hasTokenRouteAdminAccess({ level: 'worker', scopes: ['tasks:admin'] }, request('/api/tasks/bulk', 'POST'), 'tasks:admin')).toBe(true);
    // A level stored alongside scopes is never consulted.
    expect(hasTokenRouteAdminAccess({ level: 'admin', scopes: ['tasks:write'] }, request('/api/tasks/bulk', 'POST'), 'tasks:admin')).toBe(false);
  });
  test('a workspace-restricted token cannot pass an admin gate on a route it cannot reach', () => {
    const token = { scopes: ['admin'], workspaceIds: ['ws-a'] };
    expect(hasTokenRouteAdminAccess(token, request('/api/workspaces/ws-b/skills', 'POST'))).toBe(false);
    expect(hasTokenRouteAdminAccess(token, request('/api/workspaces/ws-a/skills', 'POST'))).toBe(true);
  });
  test('no scope a team member can grant is admin-tier or passes a no-capability admin gate', () => {
    const memberGrantable = TOKEN_SCOPES.filter(scope => !requiresTeamAdminToGrant(scope));
    expect(memberGrantable.length).toBeGreaterThan(0);
    for (const scope of memberGrantable) expect(ADMIN_TIER_SCOPES.has(scope)).toBe(false);
    const memberToken = { level: 'worker', scopes: memberGrantable };
    for (const [path, method] of [
      ['/api/cbm/metrics', 'GET'], ['/api/connectors', 'GET'], ['/api/connectors/c1', 'GET'],
      ['/api/connectors/c1/status', 'GET'], ['/api/connectors/c1/shares', 'GET'],
      ['/api/workspaces/ws-a/connectors', 'GET'], ['/api/missions/m1', 'GET'], ['/api/tasks/bulk', 'POST'],
    ]) {
      expect(hasTokenRouteAdminAccess(memberToken, request(path, method))).toBe(false);
    }
    // An analytics reader still reads CBM metrics, through the explicit grant at that route.
    expect(hasTokenRouteAdminAccess({ level: 'worker', scopes: ['analytics:read'] }, request('/api/cbm/metrics'), 'analytics:read')).toBe(true);
  });
  test('the admin scope passes a no-capability gate on an ordinary-scope route', () => {
    const admin = { level: 'admin', scopes: TOKEN_PRESETS.admin.scopes };
    expect(adminCapabilityForRoute('/api/workspaces/ws-a/connectors', 'GET')).toBeNull();
    expect(hasTokenRouteAdminAccess(admin, request('/api/workspaces/ws-a/connectors'))).toBe(true);
    expect(hasTokenRouteAdminAccess({ ...admin, workspaceIds: ['ws-b'] }, request('/api/workspaces/ws-a/connectors'))).toBe(false);
  });
});
