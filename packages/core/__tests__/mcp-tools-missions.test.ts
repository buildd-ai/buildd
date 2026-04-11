import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function createMockContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'admin',
    ...overrides,
  };
}

describe('manage_missions — workspace resolution', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('resolves workspace name to ID on create', async () => {
    // First call: resolveWorkspaceId fetches /api/workspaces
    mockApi.mockResolvedValueOnce({
      workspaces: [
        { id: MOCK_WORKSPACE_ID, name: 'build', repo: 'buildd-ai/buildd' },
      ],
    });
    // Second call: POST /api/missions
    mockApi.mockResolvedValueOnce({
      id: 'mission-1',
      title: 'Test Mission',
      status: 'active',
      priority: 5,
    });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      {
        action: 'create',
        title: 'Test Mission',
        workspaceId: 'build',
      },
      createMockContext(),
    );

    // Should have called /api/workspaces to resolve name
    expect(mockApi.mock.calls[0][0]).toBe('/api/workspaces');
    // Should have POSTed with the resolved UUID
    const [endpoint, opts] = mockApi.mock.calls[1];
    expect(endpoint).toBe('/api/missions');
    const body = JSON.parse(opts.body);
    expect(body.workspaceId).toBe(MOCK_WORKSPACE_ID);
  });

  it('passes UUID workspaceId directly on create', async () => {
    mockApi.mockResolvedValueOnce({
      id: 'mission-1',
      title: 'Test Mission',
      status: 'active',
      priority: 5,
    });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      {
        action: 'create',
        title: 'Test Mission',
        workspaceId: MOCK_WORKSPACE_ID,
      },
      createMockContext(),
    );

    // Should POST directly without resolving (UUID is passed through)
    const [endpoint, opts] = mockApi.mock.calls[0];
    expect(endpoint).toBe('/api/missions');
    const body = JSON.parse(opts.body);
    expect(body.workspaceId).toBe(MOCK_WORKSPACE_ID);
  });

  it('throws when workspace name cannot be resolved on create', async () => {
    mockApi.mockResolvedValueOnce({ workspaces: [] });

    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'manage_missions',
        {
          action: 'create',
          title: 'Test Mission',
          workspaceId: 'nonexistent',
        },
        createMockContext(),
      ),
    ).rejects.toThrow('Workspace not found: nonexistent');
  });

  it('resolves workspace name to ID on update', async () => {
    // First call: resolveWorkspaceId fetches /api/workspaces
    mockApi.mockResolvedValueOnce({
      workspaces: [
        { id: MOCK_WORKSPACE_ID, name: 'build', repo: 'buildd-ai/buildd' },
      ],
    });
    // Second call: PATCH /api/missions/:id
    mockApi.mockResolvedValueOnce({
      id: 'mission-1',
      title: 'Updated Mission',
      status: 'active',
    });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      {
        action: 'update',
        missionId: 'mission-1',
        workspaceId: 'build',
      },
      createMockContext(),
    );

    expect(mockApi.mock.calls[0][0]).toBe('/api/workspaces');
    const [endpoint, opts] = mockApi.mock.calls[1];
    expect(endpoint).toBe('/api/missions/mission-1');
    const body = JSON.parse(opts.body);
    expect(body.workspaceId).toBe(MOCK_WORKSPACE_ID);
  });

  it('resolves workspace name to ID on list', async () => {
    // First call: resolveWorkspaceId fetches /api/workspaces
    mockApi.mockResolvedValueOnce({
      workspaces: [
        { id: MOCK_WORKSPACE_ID, name: 'build', repo: 'buildd-ai/buildd' },
      ],
    });
    // Second call: GET /api/missions
    mockApi.mockResolvedValueOnce({ missions: [] });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      {
        action: 'list',
        workspaceId: 'build',
      },
      createMockContext(),
    );

    expect(mockApi.mock.calls[0][0]).toBe('/api/workspaces');
    expect(mockApi.mock.calls[1][0]).toContain(`workspaceId=${MOCK_WORKSPACE_ID}`);
  });
});
