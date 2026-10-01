import { describe, expect, mock, test } from 'bun:test';
import { handleBuilddAction, type ActionContext } from '../mcp-tools';
const context = (scopes: string[] | null, level: 'admin' | 'worker' | 'trigger' = 'worker'): ActionContext => ({
  getLevel: async () => level,
  getScopes: async () => scopes,
  getWorkspaceId: async () => 'workspace-test',
});

describe('MCP explicit token scopes', () => {
  test('allows analytics with a trigger-level token', async () => {
    const api = mock(async () => ({ runners: [] }));
    await handleBuilddAction(api, 'list_runners', {}, context(['analytics:read'], 'trigger'));
    expect(api).toHaveBeenCalled();
  });
  test('scopes override admin level rather than adding to it', async () => {
    const api = mock(async () => ({}));
    const result = await handleBuilddAction(api, 'manage_secrets', {}, context(['analytics:read'], 'admin'));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).requiredScope).toBe('secrets');
    expect(api).not.toHaveBeenCalled();
  });
  test('a schedule scope reaches former admin actions', async () => {
    const api = mock(async () => ({ schedules: [] }));
    const result = await handleBuilddAction(api, 'pause_schedules', {}, context(['schedules:write']));
    expect(result.isError).not.toBe(true);
    expect(api).toHaveBeenCalled();
  });
  test('null scopes preserve the old admin gate', async () => {
    const result = await handleBuilddAction(async () => ({}), 'pause_schedules', {}, context(null));
    expect(JSON.parse(result.content[0].text).requiredLevel).toBe('admin');
  });
  test('an empty list cannot reach even read actions', async () => {
    const result = await handleBuilddAction(async () => ({}), 'list_tasks', {}, context([], 'admin'));
    expect(JSON.parse(result.content[0].text).requiredScope).toBe('tasks:read');
  });
});
