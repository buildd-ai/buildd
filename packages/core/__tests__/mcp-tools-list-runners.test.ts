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

// list_runners closes the friction gap: the runner heartbeat snapshot
// (currentCommit, diskCommit, commitDrift, updating, updateAvailable,
// trackedBranch, last heartbeat) was only ever reachable via
// GET /api/workers/active, which requires an API key no MCP action exposed.
describe('list_runners', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('is available to worker-level tokens', () => {
    expect(workerActions).toContain('list_runners');
  });

  it('calls GET /api/workers/active with no params', async () => {
    mockApi.mockResolvedValueOnce({ activeLocalUis: [] });

    await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', {}, ctx());

    expect(mockApi.mock.calls[0][0]).toBe('/api/workers/active');
  });

  it('reports no runners when the list is empty', async () => {
    mockApi.mockResolvedValueOnce({ activeLocalUis: [] });

    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', {}, ctx());

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/No active runners/);
  });

  it('surfaces the full heartbeat snapshot per runner', async () => {
    mockApi.mockResolvedValueOnce({
      activeLocalUis: [
        {
          localUiUrl: 'http://localhost:8766',
          accountName: 'Runner A',
          activeWorkers: 1,
          maxConcurrent: 3,
          capacity: 2,
          workspaceIds: ['ws-1'],
          workspaceNames: ['My Workspace'],
          runnerCommit: '5bfaeef',
          runnerVersion: '0.206.0',
          currentCommit: 'stale-sha',
          diskCommit: 'stale-sha',
          commitDrift: false,
          updating: false,
          updateAvailable: true,
          updateAvailableSince: '2026-09-20T12:00:00.000Z',
          trackedBranch: 'main',
          upToDateWithDeployed: false,
          lastUpdated: '2026-09-27T00:00:00.000Z',
        },
      ],
    });

    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', {}, ctx());
    const out = res.content[0].text;

    expect(out).toContain('Runner A');
    expect(out).toContain('http://localhost:8766');
    expect(out).toContain('capacity 1/3');
    expect(out).toContain('branch main');
    expect(out).toContain('runnerCommit=5bfaeef');
    expect(out).toContain('runnerVersion=0.206.0');
    expect(out).toContain('currentCommit=stale-sha');
    expect(out).toContain('diskCommit=stale-sha');
    expect(out).toContain('commitDrift=false');
    expect(out).toContain('updating=false');
    expect(out).toContain('updateAvailable=true');
    expect(out).toContain('updateAvailableSince=2026-09-20T12:00:00.000Z');
    expect(out).toContain('upToDateWithDeployed=false');
    expect(out).toContain('workspaces: My Workspace');
    expect(out).toContain('last heartbeat 2026-09-27T00:00:00.000Z');
  });

  it('omits updateAvailableSince when the runner is up to date', async () => {
    mockApi.mockResolvedValueOnce({
      activeLocalUis: [
        {
          localUiUrl: 'http://localhost:8766',
          accountName: 'Runner A',
          activeWorkers: 0,
          maxConcurrent: 3,
          capacity: 3,
          workspaceNames: [],
          currentCommit: 'sha',
          diskCommit: 'sha',
          commitDrift: false,
          updating: false,
          updateAvailable: false,
          updateAvailableSince: null,
          trackedBranch: 'dev',
          upToDateWithDeployed: null,
          lastUpdated: '2026-09-27T00:00:00.000Z',
        },
      ],
    });

    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', {}, ctx());
    const out = res.content[0].text;

    expect(out).toContain('updateAvailable=false');
    expect(out).not.toContain('updateAvailableSince');
    // dev-tracking runner: upToDateWithDeployed is never meaningful, so it's omitted.
    expect(out).not.toContain('upToDateWithDeployed');
    expect(out).toContain('workspaces: none');
  });
});
