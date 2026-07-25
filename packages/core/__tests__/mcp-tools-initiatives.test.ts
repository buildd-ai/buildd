import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, adminActions, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function createMockContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'admin',
    ...overrides,
  };
}

describe('manage_initiatives', () => {
  let mockApi: ReturnType<typeof mock>;
  beforeEach(() => { mockApi = mock(); });

  it('is an admin-tier action', () => {
    expect(adminActions).toContain('manage_initiatives');
  });

  it('creates an initiative via POST /api/initiatives', async () => {
    mockApi.mockResolvedValueOnce({ id: 'init-1', title: 'Platform', status: 'active', priority: 0 });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'manage_initiatives',
      { action: 'create', title: 'Platform' }, createMockContext());
    const [endpoint, opts] = mockApi.mock.calls[0];
    expect(endpoint).toBe('/api/initiatives');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body).title).toBe('Platform');
    // Guides the agent to file missions under it
    expect((res as any).content[0].text).toContain('init-1');
  });

  it('mirrors the created initiative into the team-scoped `initiative` corpus', async () => {
    mockApi.mockResolvedValueOnce({ id: 'init-1', title: 'Platform', description: 'Harden it', status: 'active', priority: 0 });
    const upsert = mock(async () => ({ inserted: 1, updated: 0 }));
    await handleBuilddAction(mockApi as unknown as ApiFn, 'manage_initiatives',
      { action: 'create', title: 'Platform', description: 'Harden it' },
      createMockContext({ teamId: 'team-x', knowledgeStore: { upsert } as any }));
    expect(upsert).toHaveBeenCalledTimes(1);
    const [ns, chunks] = upsert.mock.calls[0];
    expect(ns).toBe('team-x:initiative'); // team-scoped, not workspace-scoped
    expect(chunks[0].id).toBe('initiative:init-1');
    expect(chunks[0].sourceType).toBe('initiative');
    expect(chunks[0].content).toContain('Platform');
    expect(chunks[0].content).toContain('Harden it');
  });

  it('re-mirrors on update so the card stays in sync', async () => {
    mockApi.mockResolvedValueOnce({ id: 'init-1', title: 'Renamed', description: null, status: 'paused' });
    const upsert = mock(async () => ({ inserted: 0, updated: 1 }));
    await handleBuilddAction(mockApi as unknown as ApiFn, 'manage_initiatives',
      { action: 'update', initiativeId: 'init-1', title: 'Renamed', status: 'paused' },
      createMockContext({ teamId: 'team-x', knowledgeStore: { upsert } as any }));
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toBe('team-x:initiative');
    expect(upsert.mock.calls[0][1][0].content).toContain('Renamed');
  });

  it('create succeeds even when there is no knowledgeStore (mirror is best-effort)', async () => {
    mockApi.mockResolvedValueOnce({ id: 'init-2', title: 'NoKB', status: 'active', priority: 0 });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'manage_initiatives',
      { action: 'create', title: 'NoKB' }, createMockContext({ teamId: 'team-x' }));
    expect((res as any).content[0].text).toContain('init-2');
  });

  it('get returns a KB-optimized brief with rollup + missions', async () => {
    mockApi.mockResolvedValueOnce({
      id: 'init-1', title: 'Platform', status: 'active', description: 'Harden the platform',
      progress: { progress: 60, completedMissions: 1, totalMissions: 2, completedTasks: 3, totalTasks: 5, status: 'active' },
      missions: [
        { id: 'm-1', title: 'A', status: 'completed', progress: 100, completedTasks: 2, totalTasks: 2 },
        { id: 'm-2', title: 'B', status: 'active', progress: 33, completedTasks: 1, totalTasks: 3 },
      ],
      artifacts: [{ id: 'a-1', title: 'Roadmap', type: 'content' }],
    });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'manage_initiatives',
      { action: 'get', initiativeId: 'init-1' }, createMockContext());
    expect(mockApi.mock.calls[0][0]).toBe('/api/initiatives/init-1');
    const text = (res as any).content[0].text;
    expect(text).toContain('60%');
    expect(text).toContain('1/2 missions');
    expect(text).toContain('3/5 tasks');
    expect(text).toContain('A');
    expect(text).toContain('Roadmap');
  });

  it('link_mission PATCHes the mission with initiativeId', async () => {
    mockApi.mockResolvedValueOnce({});
    await handleBuilddAction(mockApi as unknown as ApiFn, 'manage_initiatives',
      { action: 'link_mission', initiativeId: 'init-1', missionId: 'm-9' }, createMockContext());
    const [endpoint, opts] = mockApi.mock.calls[0];
    expect(endpoint).toBe('/api/missions/m-9');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body).initiativeId).toBe('init-1');
  });

  it('unlink_mission PATCHes the mission with initiativeId=null', async () => {
    mockApi.mockResolvedValueOnce({});
    await handleBuilddAction(mockApi as unknown as ApiFn, 'manage_initiatives',
      { action: 'unlink_mission', missionId: 'm-9' }, createMockContext());
    expect(JSON.parse(mockApi.mock.calls[0][1].body).initiativeId).toBeNull();
  });

  it('delete DELETEs the initiative', async () => {
    mockApi.mockResolvedValueOnce({ success: true });
    await handleBuilddAction(mockApi as unknown as ApiFn, 'manage_initiatives',
      { action: 'delete', initiativeId: 'init-1' }, createMockContext());
    const [endpoint, opts] = mockApi.mock.calls[0];
    expect(endpoint).toBe('/api/initiatives/init-1');
    expect(opts.method).toBe('DELETE');
  });

  it('throws on an unknown action', async () => {
    await expect(handleBuilddAction(mockApi as unknown as ApiFn, 'manage_initiatives',
      { action: 'frobnicate' }, createMockContext())).rejects.toThrow('Unknown initiatives action');
  });

  it('get requires initiativeId', async () => {
    await expect(handleBuilddAction(mockApi as unknown as ApiFn, 'manage_initiatives',
      { action: 'get' }, createMockContext())).rejects.toThrow('initiativeId is required');
  });
});

describe('manage_missions — initiativeId', () => {
  let mockApi: ReturnType<typeof mock>;
  beforeEach(() => { mockApi = mock(); });

  it('threads initiativeId into the create body', async () => {
    mockApi.mockResolvedValueOnce({ id: 'm-1', title: 'M', status: 'active', priority: 0 });
    await handleBuilddAction(mockApi as unknown as ApiFn, 'manage_missions',
      { action: 'create', title: 'M', initiativeId: 'init-1' }, createMockContext());
    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.initiativeId).toBe('init-1');
  });

  it('threads initiativeId=null into the update body (unlink)', async () => {
    mockApi.mockResolvedValueOnce({ id: 'm-1', title: 'M', status: 'active' });
    await handleBuilddAction(mockApi as unknown as ApiFn, 'manage_missions',
      { action: 'update', missionId: 'm-1', initiativeId: null }, createMockContext());
    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.initiativeId).toBeNull();
  });
});

describe('artifacts — initiative scoping', () => {
  let mockApi: ReturnType<typeof mock>;
  beforeEach(() => { mockApi = mock(); });

  it('create_artifact with initiativeId POSTs to the initiative artifacts route', async () => {
    mockApi.mockResolvedValueOnce({ artifact: { id: 'a-1', title: 'Roadmap', type: 'content', shareUrl: 'x' } });
    await handleBuilddAction(mockApi as unknown as ApiFn, 'create_artifact',
      { action: 'create_artifact', initiativeId: 'init-1', type: 'content', title: 'Roadmap', content: 'x' },
      createMockContext());
    const [endpoint, opts] = mockApi.mock.calls[0];
    expect(endpoint).toBe('/api/initiatives/init-1/artifacts');
    expect(opts.method).toBe('POST');
  });

  it('list_artifacts with initiativeId GETs the rolled-up initiative artifacts', async () => {
    mockApi.mockResolvedValueOnce({ artifacts: [{ id: 'a-1', title: 'Roadmap', type: 'content', updatedAt: 'now' }] });
    const res = await handleBuilddAction(mockApi as unknown as ApiFn, 'list_artifacts',
      { action: 'list_artifacts', initiativeId: 'init-1' }, createMockContext());
    expect(mockApi.mock.calls[0][0]).toBe('/api/initiatives/init-1/artifacts');
    expect((res as any).content[0].text).toContain('child missions');
  });
});
