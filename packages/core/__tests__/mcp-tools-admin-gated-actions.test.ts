/**
 * Admin-gated MCP actions: privilege failures must return a structured 403-style
 * result (isError=true, JSON body) rather than throwing or returning a bare
 * "This operation requires an admin-level token" string.
 *
 * Regression: non-admin tokens were getting back error messages that looked
 * identical to expired/invalid auth (401), causing agents to tell operators to
 * reconnect instead of explaining the privilege gap.
 */
import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';

function ctx(level: 'trigger' | 'worker' | 'admin' = 'admin'): ActionContext {
  return {
    workspaceId: WS_ID,
    getWorkspaceId: async () => WS_ID,
    getLevel: async () => level,
  };
}

const noopApi = (async () => ({})) as unknown as ApiFn;

/**
 * Helper that asserts an admin-only action returns a structured forbidden
 * error when called with a non-admin token, and does NOT call the API.
 */
async function expectForbidden(action: string, params: Record<string, unknown> = {}, tokenLevel: 'worker' | 'trigger' = 'worker') {
  const mockApi = mock(async () => ({})) as unknown as ApiFn;
  const result = await handleBuilddAction(mockApi, action, params, ctx(tokenLevel));

  // Must return an error result (not throw)
  expect(result.isError).toBe(true);

  // Must be parseable as JSON with structured fields
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(result.content[0].text);
  } catch {
    throw new Error(`Expected JSON body for forbidden response, got: ${result.content[0].text}`);
  }

  expect(body.error).toBe('forbidden');
  expect(body.requiredLevel).toBe('admin');
  expect(body.tokenLevel).toBe(tokenLevel);
  expect(typeof body.reason).toBe('string');
  expect((body.reason as string).toLowerCase()).toContain('admin');

  // Must NOT have made any API calls (privilege failure is pre-flight)
  expect((mockApi as ReturnType<typeof mock>).mock.calls.length).toBe(0);
}

describe('Admin-gated actions return structured 403 for non-admin tokens', () => {
  // Core admin action: this is the one that caused the original incident
  it('manage_secrets list', () => expectForbidden('manage_secrets', { action: 'list' }));
  it('manage_missions list', () => expectForbidden('manage_missions', { action: 'list' }));
  it('manage_workspaces list', () => expectForbidden('manage_workspaces', { action: 'list' }));
  it('manage_watched_projects list', () => expectForbidden('manage_watched_projects', { action: 'list' }));
  it('manage_model_tiers list', () => expectForbidden('manage_model_tiers', { action: 'list' }));
  it('register_skill', () => expectForbidden('register_skill', { name: 'x', content: 'y' }));
  it('list_skills', () => expectForbidden('list_skills'));
  it('get_skill', () => expectForbidden('get_skill', { slug: 'builder' }));
  it('update_skill', () => expectForbidden('update_skill', { slug: 'builder' }));
  it('delete_skill', () => expectForbidden('delete_skill', { slug: 'builder' }));
  it('approve_plan', () => expectForbidden('approve_plan', { taskId: 'task-1' }));
  it('reject_plan', () => expectForbidden('reject_plan', { taskId: 'task-1', feedback: 'nope' }));
  it('create_schedule', () => expectForbidden('create_schedule', { name: 'x', cronExpression: '0 * * * *', title: 'x' }));
  it('update_schedule', () => expectForbidden('update_schedule', { scheduleId: 's-1' }));
  it('delete_schedule', () => expectForbidden('delete_schedule', { scheduleId: 's-1' }));
  it('pause_schedules', () => expectForbidden('pause_schedules'));
  it('trigger_release', () => expectForbidden('trigger_release', { workspaceId: WS_ID }));
  it('release_status', () => expectForbidden('release_status', { workspaceId: WS_ID }));
  it('send_agent_message', () => expectForbidden('send_agent_message', { taskId: 'task-1', message: 'hi' }));
  it('spec_compare', () => expectForbidden('spec_compare', { feature: 'auth' }));
  // trigger level also gets a structured 403 for admin actions
  it('manage_secrets: trigger token also gets structured 403', () =>
    expectForbidden('manage_secrets', { action: 'list' }, 'trigger'));
});

describe('Structured error body fields', () => {
  it('includes action name in reason', async () => {
    const result = await handleBuilddAction(noopApi, 'manage_secrets', { action: 'list' }, ctx('worker'));
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.reason).toContain('manage_secrets');
  });

  it('includes tokenLevel for worker token', async () => {
    const result = await handleBuilddAction(noopApi, 'manage_missions', { action: 'list' }, ctx('worker'));
    const body = JSON.parse(result.content[0].text);
    expect(body.tokenLevel).toBe('worker');
  });

  it('includes tokenLevel for trigger token', async () => {
    const result = await handleBuilddAction(noopApi, 'trigger_release', { workspaceId: WS_ID }, ctx('trigger'));
    const body = JSON.parse(result.content[0].text);
    expect(body.tokenLevel).toBe('trigger');
  });
});

describe('Admin-level tokens can still use admin actions', () => {
  it('manage_secrets list succeeds for admin', async () => {
    const mockApi = mock(async () => ({ secrets: [] })) as unknown as ApiFn;
    const result = await handleBuilddAction(mockApi, 'manage_secrets', { action: 'list' }, ctx('admin'));
    expect(result.isError).toBeUndefined();
  });
});
