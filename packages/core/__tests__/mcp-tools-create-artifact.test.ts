import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const MOCK_MISSION_ID = '00000000-0000-0000-0000-000000000099';
const MOCK_INITIATIVE_ID = '00000000-0000-0000-0000-000000000077';
const MOCK_WORKER_ID = '00000000-0000-0000-0000-000000000055';

function createMockContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

// create_artifact's own tool description promises exactly three ways to scope
// an artifact with no worker context: workerId (auto-resolved), missionId, or
// initiativeId. From an account-token MCP session with none of the three —
// the shape an attended session hits when copying design work in with no
// worker running — the error used to name only workerId, hiding the
// missionId/initiativeId path that would actually succeed.
describe('create_artifact — worker context resolution', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('names missionId and initiativeId, not just workerId, when none of the three is available', async () => {
    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'create_artifact',
        { type: 'summary', title: 'Untethered artifact' },
        createMockContext(), // no ctx.workerId
      ),
    ).rejects.toThrow(/missionId/);

    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'create_artifact',
        { type: 'summary', title: 'Untethered artifact' },
        createMockContext(),
      ),
    ).rejects.toThrow(/initiativeId/);

    expect(mockApi).not.toHaveBeenCalled();
  });

  it('creates a mission-level artifact with no worker when missionId is passed', async () => {
    mockApi.mockResolvedValue({ artifact: { id: 'art-1', title: 'Design copy-in', type: 'content' } });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_artifact',
      { type: 'content', title: 'Design copy-in', missionId: MOCK_MISSION_ID },
      createMockContext(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    const [endpoint] = mockApi.mock.calls[0];
    expect(endpoint).toBe(`/api/missions/${MOCK_MISSION_ID}/artifacts`);
  });

  it('creates an initiative-level artifact with no worker when initiativeId is passed', async () => {
    mockApi.mockResolvedValue({ artifact: { id: 'art-2', title: 'Roadmap', type: 'content' } });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_artifact',
      { type: 'content', title: 'Roadmap', initiativeId: MOCK_INITIATIVE_ID },
      createMockContext(),
    );

    const [endpoint] = mockApi.mock.calls[0];
    expect(endpoint).toBe(`/api/initiatives/${MOCK_INITIATIVE_ID}/artifacts`);
  });

  it('still auto-resolves workerId from context when a worker is running', async () => {
    // A worker-scoped context also triggers the write fence's own worker
    // lookup (a preflight to block orphan writes from an externally
    // terminated task) — the artifact POST is not necessarily the first call.
    mockApi.mockResolvedValue({ artifact: { id: 'art-3', title: 'Worker output', type: 'summary' } });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_artifact',
      { type: 'summary', title: 'Worker output' },
      createMockContext({ workerId: MOCK_WORKER_ID }),
    );

    const artifactCall = mockApi.mock.calls.find(([endpoint]: [string]) => endpoint.endsWith('/artifacts'));
    expect(artifactCall?.[0]).toBe(`/api/workers/${MOCK_WORKER_ID}/artifacts`);
  });
});
