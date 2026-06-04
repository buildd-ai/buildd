import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

// Regression coverage for the 2026-05-25 incident: an OAuth token with access
// to multiple workspaces called claim_task without an explicit workspaceId,
// the resolver picked the wrong workspace, the agent flailed on a path that
// didn't exist, and 4 workers burned in the retry loop before being killed.
// The guard refuses ambiguous mutating/aggregating actions for OAuth tokens
// when no workspace pin exists.

const WS_A = '00000000-0000-0000-0000-000000000001';
const WS_B = '00000000-0000-0000-0000-000000000002';

function ctxOauth(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    authType: 'oauth',
    getWorkspaceId: async () => null,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

function ctxApi(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    authType: 'api',
    workspaceId: WS_A,
    getWorkspaceId: async () => WS_A,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('multi-workspace guard — requireExplicitWorkspace', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('rejects claim_task for OAuth tokens with >1 workspace and no pin', async () => {
    mockApi.mockResolvedValueOnce({
      workspaces: [
        { id: WS_A, name: 'dispatch-family', repo: 'org/dispatch' },
        { id: WS_B, name: 'moa-ops', repo: 'org/moa-ops' },
      ],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'claim_task',
      {},
      ctxOauth(),
    );

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/2 workspaces/);
    expect(text).toMatch(/dispatch-family/);
    expect(text).toMatch(/moa-ops/);
    // Must NOT have fired the actual claim API
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][0]).toBe('/api/workspaces');
  });

  it('rejects create_task for OAuth tokens with >1 workspace and no pin', async () => {
    mockApi.mockResolvedValueOnce({
      workspaces: [
        { id: WS_A, name: 'a', repo: null },
        { id: WS_B, name: 'b', repo: null },
      ],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      { title: 't', description: 'd' },
      ctxOauth(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/workspaceId/);
  });

  it('rejects list_tasks for OAuth tokens with >1 workspace and no pin', async () => {
    mockApi.mockResolvedValueOnce({
      workspaces: [
        { id: WS_A, name: 'a' },
        { id: WS_B, name: 'b' },
      ],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'list_tasks',
      {},
      ctxOauth(),
    );

    expect(result.isError).toBe(true);
  });

  it('allows claim_task when workspaceId is passed explicitly in params', async () => {
    // /api/workspaces should NOT be called — guard short-circuits on params.workspaceId
    mockApi.mockResolvedValue({ workers: [] });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'claim_task',
      { workspaceId: WS_A },
      ctxOauth(),
    );

    expect(result.isError).toBeFalsy();
    // Confirm /api/workspaces was not called for enumeration
    const enumerated = mockApi.mock.calls.find((c) => c[0] === '/api/workspaces');
    expect(enumerated).toBeUndefined();
  });

  it('allows claim_task when ctx.workspaceId is URL-pinned', async () => {
    mockApi.mockResolvedValue({ workers: [] });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'claim_task',
      {},
      ctxOauth({ workspaceId: WS_A }),
    );

    expect(result.isError).toBeFalsy();
    const enumerated = mockApi.mock.calls.find((c) => c[0] === '/api/workspaces');
    expect(enumerated).toBeUndefined();
  });

  it('skips the guard for API-key tokens (workspace-scoped at creation)', async () => {
    mockApi.mockResolvedValue({ workers: [] });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'claim_task',
      {},
      ctxApi(),
    );

    expect(result.isError).toBeFalsy();
    const enumerated = mockApi.mock.calls.find((c) => c[0] === '/api/workspaces');
    expect(enumerated).toBeUndefined();
  });

  it('skips the guard when the OAuth token only has 1 accessible workspace', async () => {
    mockApi.mockResolvedValueOnce({
      workspaces: [{ id: WS_A, name: 'only', repo: 'org/only' }],
    });
    // Second call: the actual claim
    mockApi.mockResolvedValueOnce({ workers: [] });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'claim_task',
      {},
      ctxOauth(),
    );

    expect(result.isError).toBeFalsy();
  });

  it('does not guard non-ambiguous actions like get_task or update_progress', async () => {
    mockApi.mockResolvedValue({ id: 'task-1', title: 't', status: 'pending' });

    const getResult = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_task',
      { taskId: 'task-1' },
      ctxOauth(),
    );

    expect(getResult.isError).toBeFalsy();
    // No /api/workspaces enumeration for get_task — the guard doesn't apply
    const enumerated = mockApi.mock.calls.find((c) => c[0] === '/api/workspaces');
    expect(enumerated).toBeUndefined();
  });
});
