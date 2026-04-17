import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const MOCK_MISSION_ID = '00000000-0000-0000-0000-000000000099';

function createMockContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('list_artifacts — missionId filter', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('passes missionId as query param when provided', async () => {
    mockApi.mockResolvedValue({ artifacts: [] });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'list_artifacts',
      { missionId: MOCK_MISSION_ID },
      createMockContext(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    const [endpoint] = mockApi.mock.calls[0];
    const url = new URL(endpoint, 'http://localhost');
    expect(url.pathname).toBe(`/api/workspaces/${MOCK_WORKSPACE_ID}/artifacts`);
    expect(url.searchParams.get('missionId')).toBe(MOCK_MISSION_ID);
  });

  it('composes missionId with type and key filters', async () => {
    mockApi.mockResolvedValue({
      artifacts: [
        { id: 'art-1', title: 'Summary', type: 'summary', key: 'mission-sum', updatedAt: '2026-01-01' },
      ],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'list_artifacts',
      { missionId: MOCK_MISSION_ID, type: 'summary', key: 'mission-sum' },
      createMockContext(),
    );

    const [endpoint] = mockApi.mock.calls[0];
    const url = new URL(endpoint, 'http://localhost');
    expect(url.searchParams.get('missionId')).toBe(MOCK_MISSION_ID);
    expect(url.searchParams.get('type')).toBe('summary');
    expect(url.searchParams.get('key')).toBe('mission-sum');
    expect(result.content[0].text).toContain('1 artifact(s)');
  });

  it('omits missionId param when not provided', async () => {
    mockApi.mockResolvedValue({ artifacts: [] });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'list_artifacts',
      {},
      createMockContext(),
    );

    const [endpoint] = mockApi.mock.calls[0];
    const url = new URL(endpoint, 'http://localhost');
    expect(url.searchParams.has('missionId')).toBe(false);
  });

  it('returns existing behavior when no filters provided', async () => {
    mockApi.mockResolvedValue({ artifacts: [] });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'list_artifacts',
      {},
      createMockContext(),
    );

    expect(result.content[0].text).toContain('No artifacts found');
  });
});
