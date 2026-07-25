import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function createContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WORKSPACE_ID,
    getWorkspaceId: async () => WORKSPACE_ID,
    getLevel: async () => 'admin',
    ...overrides,
  };
}

describe('manage_workspaces get', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('returns the current workspace config as lossless JSON', async () => {
    const config = {
      gitConfig: {
        autoMergePR: true,
        autoMergeMaxLines: 250,
        mergePolicy: { tier: 'agent-review', reviewerRoleSlug: 'reviewer' },
      },
      configStatus: 'configured',
      releaseConfig: null,
    };
    mockApi.mockResolvedValue(config);

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_workspaces',
      { action: 'get', workspaceId: WORKSPACE_ID },
      createContext(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][0]).toBe(`/api/workspaces/${WORKSPACE_ID}/config`);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(
      `Workspace ${WORKSPACE_ID} config:\n${JSON.stringify(config, null, 2)}`,
    );
  });

  it('uses the workspace from action context when workspaceId is omitted', async () => {
    mockApi.mockResolvedValue({
      gitConfig: null,
      configStatus: 'pending',
      releaseConfig: null,
    });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_workspaces',
      { action: 'get' },
      createContext(),
    );

    expect(mockApi.mock.calls[0][0]).toBe(`/api/workspaces/${WORKSPACE_ID}/config`);
  });

  it('requires a resolvable workspace', async () => {
    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'manage_workspaces',
        { action: 'get' },
        createContext({
          workspaceId: undefined,
          getWorkspaceId: async () => null,
        }),
      ),
    ).rejects.toThrow('workspaceId is required for get');

    expect(mockApi).not.toHaveBeenCalled();
  });
});
