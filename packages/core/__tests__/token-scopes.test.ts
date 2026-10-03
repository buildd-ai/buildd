import { describe, expect, test } from 'bun:test';
import { TOKEN_PRESETS, TOKEN_SCOPES, hasTokenScope, requiredScopeForAction, tokenWorkspaceAllowed, isTokenScope, LEGACY_LEVEL_PRESET } from '../token-scopes';

describe('token scopes', () => {
  test('CI and analytics presets need no admin permission', () => {
    expect(TOKEN_PRESETS.ci.scopes).toContain('tasks:write');
    expect(TOKEN_PRESETS.analytics.scopes).toEqual(['analytics:read']);
    expect(TOKEN_PRESETS.ci.scopes).not.toContain('admin');
  });
  test('explicit scopes grant only their named capabilities', () => {
    expect(hasTokenScope(['analytics:read'], 'analytics:read')).toBe(true);
    expect(hasTokenScope(['analytics:read'], 'tasks:write')).toBe(false);
    expect(hasTokenScope([], 'tasks:read')).toBe(false);
    expect(hasTokenScope(null, 'tasks:read')).toBe(false);
    for (const scope of TOKEN_SCOPES) expect(hasTokenScope(['admin'], scope)).toBe(true);
  });
  test('rejects unknown scopes', () => {
    expect(isTokenScope('analytics:read')).toBe(true);
    expect(isTokenScope('analytics:write')).toBe(false);
  });
  test('maps privileged actions to granular scopes', () => {
    expect(requiredScopeForAction('trigger_release')).toBe('releases');
    expect(requiredScopeForAction('manage_missions')).toBe('missions:admin');
    expect(requiredScopeForAction('manage_secrets')).toBe('secrets');
    expect(requiredScopeForAction('send_agent_message')).toBe('workers:admin');
    expect(requiredScopeForAction('approve_plan')).toBe('tasks:admin');
    expect(requiredScopeForAction('get_usage_stats')).toBe('analytics:read');
    expect(requiredScopeForAction('manage_experiments', { action: 'list' })).toBe('analytics:read');
    expect(requiredScopeForAction('manage_experiments', { action: 'create' })).toBe('admin');
    expect(requiredScopeForAction('unknown_action')).toBeNull();
  });
  test('workspace limits apply even to admin tokens', () => {
    expect(tokenWorkspaceAllowed(null, 'workspace-a')).toBe(true);
    expect(tokenWorkspaceAllowed(['workspace-a'], 'workspace-a')).toBe(true);
    expect(tokenWorkspaceAllowed(['workspace-a'], 'workspace-b')).toBe(false);
    expect(tokenWorkspaceAllowed([], 'workspace-a')).toBe(false);
    expect(tokenWorkspaceAllowed(['workspace-a'], undefined)).toBe(false);
  });
});

test('mission reads use task reading and mutations require mission administration', () => {
  expect(requiredScopeForAction('manage_missions', { action: 'list' })).toBe('tasks:read');
  expect(requiredScopeForAction('manage_missions', { action: 'get_criteria_state' })).toBe('tasks:read');
  expect(requiredScopeForAction('manage_initiatives', { action: 'get' })).toBe('tasks:read');
  expect(requiredScopeForAction('manage_missions', { action: 'arm' })).toBe('missions:admin');
});

test('workspace readiness is a read, matching its GET route; workspace mutations stay admin', () => {
  expect(requiredScopeForAction('manage_workspaces', { action: 'readiness' })).toBe('tasks:read');
  expect(requiredScopeForAction('manage_workspaces', { action: 'update' })).toBe('workspaces:admin');
  expect(requiredScopeForAction('manage_missions', { action: 'readiness' })).toBe('missions:admin');
});

test('legacy levels map to displayed presets without migrating permissions', () => {
  expect(LEGACY_LEVEL_PRESET).toEqual({ worker: 'runner', trigger: 'ci', admin: 'admin' });
});

test('runner and CI presets exclude administrative mutation capabilities', () => {
  expect(requiredScopeForAction('memory_delete')).toBe('knowledge:admin');
  expect(requiredScopeForAction('consolidate_knowledge')).toBe('knowledge:admin');
  expect(requiredScopeForAction('correct_task_result')).toBe('tasks:admin');
  expect(requiredScopeForAction('create_pr')).toBe('tasks:write');
  expect(TOKEN_PRESETS.runner.scopes.some(scope => scope.endsWith(':admin'))).toBe(false);
  expect(TOKEN_PRESETS.ci.scopes.some(scope => scope.endsWith(':admin'))).toBe(false);
  expect(hasTokenScope(['knowledge:write'], 'knowledge:admin')).toBe(false);
  expect(hasTokenScope(['workers:write'], 'workers:admin')).toBe(false);
});

test('administrative capabilities include the corresponding base operations', () => {
  expect(hasTokenScope(['tasks:admin'], 'tasks:write')).toBe(true);
  expect(hasTokenScope(['tasks:admin'], 'tasks:read')).toBe(true);
  expect(hasTokenScope(['workers:admin'], 'workers:write')).toBe(true);
  expect(hasTokenScope(['knowledge:admin'], 'knowledge:write')).toBe(true);
  expect(hasTokenScope(['workers:admin'], 'tasks:read')).toBe(false);
});
