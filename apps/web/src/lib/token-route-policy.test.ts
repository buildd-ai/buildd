import { describe, expect, test } from 'bun:test';
import { canAccessTokenRoute, hasTokenRouteAdminAccess, requiredTokenScope } from './token-route-policy';
const request = (path: string, method = 'GET') => ({ url: `https://example.test${path}`, method });
describe('REST token scope policy', () => {
  test('CI tokens can write tasks without admin and cannot read secrets', () => {
    const token = { level: 'worker', scopes: ['tasks:write'] };
    expect(canAccessTokenRoute(token, request('/api/tasks', 'POST'))).toBe(true);
    expect(hasTokenRouteAdminAccess(token, request('/api/tasks/bulk', 'POST'))).toBe(true);
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
});
