import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
  handleBuilddAction,
  workerActions,
  adminActions,
  type ApiFn,
  type ActionContext,
} from '../mcp-tools';

/**
 * list_releases / get_release regression coverage.
 *
 * PR #1875 described and implemented these two actions directly in
 * apps/web/src/app/api/mcp/route.ts but never added a case to
 * handleBuilddAction's switch — the dispatcher every OTHER transport
 * (OAuth /api/mcp-oauth, the in-process runner server) goes through. Both
 * actions threw "Unknown action" outside of the API-key /api/mcp route.
 * These tests exercise handleBuilddAction directly, the same call every
 * non-/api/mcp transport makes.
 */

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const RELEASE_ID = '00000000-0000-0000-0000-000000000002';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WORKSPACE_ID,
    authType: 'api',
    getWorkspaceId: async () => WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('list_releases / get_release registration', () => {
  it('are worker-level actions, not admin-gated', () => {
    expect((workerActions as readonly string[])).toContain('list_releases');
    expect((workerActions as readonly string[])).toContain('get_release');
    expect((adminActions as readonly string[])).not.toContain('list_releases');
    expect((adminActions as readonly string[])).not.toContain('get_release');
  });
});

describe('list_releases dispatch', () => {
  let mockApi: ReturnType<typeof mock>;
  beforeEach(() => { mockApi = mock(); });

  it('resolves the workspace and calls GET /api/releases with the shipped tasks', async () => {
    mockApi.mockResolvedValueOnce({ releases: [] });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'list_releases', {}, ctx());

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe('No releases found.');
    const [endpoint] = mockApi.mock.calls[0];
    expect(endpoint).toBe(`/api/releases?workspaceId=${WORKSPACE_ID}&include=tasks`);
  });

  it('renders one line per release plus what it shipped, not a JSON dump', async () => {
    mockApi.mockResolvedValueOnce({ releases: [{
      id: RELEASE_ID, version: 'v1.2.0', state: 'healthy', headSha: 'abcdef1234567890',
      deployedAt: '2026-09-27T17:07:33.934Z', createdAt: '2026-09-27T17:07:34.025Z', failureReason: null,
      tasks: [{ title: 'Fix login', prNumber: 12 }, { title: 'Faster claim', prNumber: null }],
    }, {
      id: 'r2', version: null, state: 'degraded', headSha: '1111111222', deployedAt: null,
      createdAt: '2026-09-26T10:00:00.000Z', failureReason: 'health check returned HTTP 502', tasks: [],
    }] });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'list_releases', {}, ctx());
    const out = res.content[0].text;
    expect(out).toContain(`- v1.2.0 · healthy · deployed 2026-09-27 17:07Z · abcdef1 (id ${RELEASE_ID})`);
    expect(out).toContain('    - #12 Fix login');
    expect(out).toContain('    - Faster claim');
    expect(out).toContain('degraded (health check returned HTTP 502)');
    expect(out).not.toContain('"archetype"');
  });

  it('forwards sinceDays and says the window when nothing matched', async () => {
    mockApi.mockResolvedValueOnce({ releases: [] });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'list_releases', { sinceDays: 7 }, ctx());
    const qs = new URLSearchParams(mockApi.mock.calls[0][0].split('?')[1]);
    expect(qs.get('sinceDays')).toBe('7');
    expect(res.content[0].text).toBe('No releases in the last 7 days.');
  });

  it('forwards missionId, state, and limit params', async () => {
    mockApi.mockResolvedValueOnce({ releases: [] });
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'list_releases',
      { missionId: 'm-1', state: 'healthy', limit: 5 },
      ctx(),
    );
    const [endpoint] = mockApi.mock.calls[0];
    const qs = new URLSearchParams(endpoint.split('?')[1]);
    expect(qs.get('missionId')).toBe('m-1');
    expect(qs.get('state')).toBe('healthy');
    expect(qs.get('limit')).toBe('5');
  });

  it('throws when no workspace can be resolved', async () => {
    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'list_releases',
        {},
        ctx({ workspaceId: undefined, getWorkspaceId: async () => null }),
      ),
    ).rejects.toThrow(/resolve workspace/i);
    expect(mockApi).toHaveBeenCalledTimes(0);
  });
});

describe('get_release dispatch', () => {
  let mockApi: ReturnType<typeof mock>;
  beforeEach(() => { mockApi = mock(); });

  it('calls GET /api/releases/:id and returns the payload', async () => {
    mockApi.mockResolvedValueOnce({ id: RELEASE_ID, attributedTasks: [] });
    const res = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'get_release',
      { releaseId: RELEASE_ID },
      ctx(),
    );

    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual({ id: RELEASE_ID, attributedTasks: [] });
    expect(mockApi).toHaveBeenCalledWith(`/api/releases/${RELEASE_ID}`);
  });

  it('throws when releaseId is missing', async () => {
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'get_release', {}, ctx()),
    ).rejects.toThrow(/releaseId is required/i);
    expect(mockApi).toHaveBeenCalledTimes(0);
  });
});
