import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, workerActions, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    workerId: '00000000-0000-0000-0000-000000000002',
    authType: 'oauth',
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

// Regression coverage for the friction: list_connectors was only implemented
// inline in apps/web/src/app/api/mcp/route.ts (the API-key transport), so the
// OAuth (/api/mcp-oauth/[workspace]) and in-process runner transports — which
// both dispatch through handleBuilddAction — threw "Unknown action". This
// exercises handleBuilddAction directly, the same call those transports make.
describe('list_connectors', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('is available to worker-level tokens', () => {
    expect(workerActions).toContain('list_connectors');
  });

  it('is reachable via handleBuilddAction (not just the inline mcp/route.ts handler)', async () => {
    mockApi.mockResolvedValueOnce({ connectors: [{ id: 'c1', name: 'GitHub', authMode: 'oauth', status: 'ok' }] });

    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'list_connectors', {}, ctx());

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.connectors).toEqual([{ id: 'c1', name: 'GitHub', authMode: 'oauth', status: 'ok' }]);
  });

  it('hits the worker-level REST route with the resolved workspace id', async () => {
    mockApi.mockResolvedValueOnce({ connectors: [] });

    await handleBuilddAction(mockApi as unknown as ApiFn, 'list_connectors', {}, ctx());

    expect(mockApi.mock.calls[0][0]).toBe(`/api/connectors/mounted?workspaceId=${MOCK_WORKSPACE_ID}`);
  });

  it('resolves workspaceId from params when ctx has none', async () => {
    mockApi.mockResolvedValueOnce({ connectors: [] });
    const noWsCtx = ctx({ workspaceId: undefined, getWorkspaceId: async () => null });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'list_connectors',
      { workspaceId: MOCK_WORKSPACE_ID },
      noWsCtx,
    );

    expect(mockApi.mock.calls[0][0]).toBe(`/api/connectors/mounted?workspaceId=${MOCK_WORKSPACE_ID}`);
  });

  it('throws a clear error when no workspace can be resolved', async () => {
    const noWsCtx = ctx({ workspaceId: undefined, getWorkspaceId: async () => null });

    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'list_connectors', {}, noWsCtx),
    ).rejects.toThrow(/Cannot resolve workspace/);
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('defaults to an empty connectors array when the route omits it', async () => {
    mockApi.mockResolvedValueOnce({});

    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'list_connectors', {}, ctx());

    expect(JSON.parse(res.content[0].text)).toEqual({ connectors: [] });
  });
});
