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
    expect(out).toContain('1 busy of 3 slots');
    expect(out).not.toContain('capacity');
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

  const runner = (over: Record<string, unknown> = {}) => ({
    localUiUrl: 'http://localhost:8766', accountName: 'Runner A', activeWorkers: 0, maxConcurrent: 10,
    workspaceIds: [MOCK_WORKSPACE_ID], workspaceNames: ['My Workspace'], trackedBranch: 'dev',
    lastUpdated: '2026-09-27T00:00:00.000Z', ...over,
  });

  it('says busy of slots, never an ambiguous a/b', async () => {
    mockApi.mockResolvedValueOnce({ activeLocalUis: [runner()] });
    const out = (await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', {}, ctx())).content[0].text;
    expect(out).toContain('0 busy of 10 slots');
    expect(out).not.toMatch(/\b0\/10\b/);
  });

  it('browser: yes only when the server says online by the summary rule; a stale capable runner is labelled, not yes', async () => {
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    mockApi.mockResolvedValueOnce({ onlineWindowMs: 180_000, activeLocalUis: [
      runner({ accountName: 'Online', browser: true, browserOnline: true, lastUpdated: ago(1) }),
      runner({ accountName: 'Stale', browser: true, browserOnline: false, lastUpdated: ago(20) }),
      runner({ accountName: 'Without', browser: false, browserOnline: false, environment: { envKeys: ['node'] } }),
      runner({ accountName: 'Unknown env', environment: null }),
    ] });
    const out = (await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', {}, ctx())).content[0].text;
    const line = (name: string) => out.split('\n').find(l => l.includes(name))!;
    expect(line('Online')).toContain('browser: yes');
    expect(line('Stale')).toContain('browser: capable, not online (heartbeat 20m ago; online = heartbeat within 3m)');
    expect(line('Stale')).not.toContain('browser: yes');
    expect(line('Without')).toContain('browser: no');
    expect(line('Unknown env')).toContain('browser: no');
  });

  it('with workspaceId: summary no and a stale browser row never reads as a plain yes', async () => {
    mockApi.mockResolvedValueOnce({
      onlineWindowMs: 180_000,
      activeLocalUis: [runner({ browser: true, browserOnline: false, canClaimInWorkspace: true, lastUpdated: new Date(Date.now() - 20 * 60_000).toISOString() })],
      workspace: { id: MOCK_WORKSPACE_ID, name: 'My Workspace' },
      browserRunnerOnline: false,
    });
    const out = (await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', { workspaceId: MOCK_WORKSPACE_ID }, ctx())).content[0].text;
    expect(out.split('\n')[0]).toBe('Browser-capable runner online for My Workspace: no');
    expect(out).not.toContain('browser: yes');
    expect(out).toContain('browser: capable, not online');
  });

  it('with workspaceId: a fresh capable runner that cannot claim there says so', async () => {
    mockApi.mockResolvedValueOnce({
      activeLocalUis: [runner({ browser: true, browserOnline: false, canClaimInWorkspace: false, lastUpdated: new Date().toISOString() })],
      workspace: { id: MOCK_WORKSPACE_ID, name: 'My Workspace' },
      browserRunnerOnline: false,
    });
    const out = (await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', { workspaceId: MOCK_WORKSPACE_ID }, ctx())).content[0].text;
    expect(out).toContain('browser: capable, cannot claim in My Workspace');
  });

  it('with workspaceId: asks the server for that workspace, keeps its runners, and gives the one-line browser answer', async () => {
    mockApi.mockResolvedValueOnce({
      activeLocalUis: [runner(), runner({ accountName: 'Elsewhere', workspaceIds: ['other-ws'] })],
      workspace: { id: MOCK_WORKSPACE_ID, name: 'My Workspace' },
      browserRunnerOnline: true,
    });
    const out = (await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', { workspaceId: MOCK_WORKSPACE_ID }, ctx())).content[0].text;
    expect(mockApi.mock.calls[0][0]).toBe(`/api/workers/active?workspaceId=${MOCK_WORKSPACE_ID}`);
    expect(out.split('\n')[0]).toBe('Browser-capable runner online for My Workspace: yes');
    expect(out).not.toContain('Elsewhere');
    expect(out).toMatch(/1 runner of other workspaces not shown; omit workspaceId for all/);
  });

  it('with workspaceId: says no, and unknown when the server could not tell', async () => {
    mockApi.mockResolvedValueOnce({ activeLocalUis: [], workspace: { id: MOCK_WORKSPACE_ID, name: 'My Workspace' }, browserRunnerOnline: false });
    const no = (await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', { workspaceId: MOCK_WORKSPACE_ID }, ctx())).content[0].text;
    expect(no).toContain('Browser-capable runner online for My Workspace: no');

    mockApi.mockResolvedValueOnce({ activeLocalUis: [], workspace: { id: MOCK_WORKSPACE_ID, name: 'My Workspace' }, browserRunnerOnline: null });
    const unknown = (await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', { workspaceId: MOCK_WORKSPACE_ID }, ctx())).content[0].text;
    expect(unknown).toContain('Browser-capable runner online for My Workspace: unknown');
  });

  it('cloud runs read as one elastic group with its runs nested, host runners unchanged', async () => {
    const fleet = { executor: 'cloud', ephemeral: true, concurrency: 1, group: 'my-dispatcher' };
    const once = (task: string) => runner({
      localUiUrl: `headless://container/once/${task}`, activeWorkers: 1, maxConcurrent: 1, capacity: 0, fleet,
      runnerCommit: 'c0ffee', runnerVersion: '0.1.0',
    });
    mockApi.mockResolvedValueOnce({ activeLocalUis: [runner({ accountName: 'Host', fleet: null }), once('a'), once('b')] });
    const out = (await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', {}, ctx())).content[0].text;
    expect(out).toContain('1 runner(s), 1 elastic group(s):');
    expect(out).toContain('Host — http://localhost:8766 — 0 busy of 10 slots');
    const groupLine = out.split('\n').find(l => l.includes('my-dispatcher'))!;
    expect(groupLine).toBe('- Cloudflare · my-dispatcher · elastic · 2 running — Runner A');
    expect(out).toContain('  run headless://container/once/a — last heartbeat 2026-09-27T00:00:00.000Z');
    expect(out).toContain('  run headless://container/once/b — last heartbeat 2026-09-27T00:00:00.000Z');
    // Not listed as machines with slots.
    expect(out).not.toContain('headless://container/once/a — 1 busy of 1 slots');
    expect(out).toContain('runnerCommit=c0ffee runnerVersion=0.1.0');
  });

  it('a run from an older build (no group) still folds, by its machine name', async () => {
    const legacy = (task: string) => runner({
      localUiUrl: `headless://container/once/${task}`, activeWorkers: 1, maxConcurrent: 1,
      fleet: { executor: null, ephemeral: true, concurrency: 1, group: null },
      environment: { labels: { hostname: 'container' } },
    });
    mockApi.mockResolvedValueOnce({ activeLocalUis: [legacy('a'), legacy('b')] });
    const out = (await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', {}, ctx())).content[0].text;
    expect(out).toContain('0 runner(s), 1 elastic group(s):');
    expect(out).toContain('- container · elastic · 2 running — Runner A');
  });

  it('with a workspaceId that does not resolve: an error, not every runner', async () => {
    mockApi.mockResolvedValueOnce({ workspaces: [] });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'list_runners', { workspaceId: 'Nope' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/"Nope"/);
    expect(mockApi.mock.calls.some((c: unknown[]) => String(c[0]).startsWith('/api/workers/active'))).toBe(false);
  });
});
