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

  it('passes status to body on create when provided', async () => {
    mockApi.mockResolvedValueOnce({
      id: 'mission-1',
      title: 'Paused Mission',
      status: 'paused',
      priority: 0,
    });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      {
        action: 'create',
        title: 'Paused Mission',
        status: 'paused',
      },
      createMockContext(),
    );

    const [endpoint, opts] = mockApi.mock.calls[0];
    expect(endpoint).toBe('/api/missions');
    const body = JSON.parse(opts.body);
    expect(body.status).toBe('paused');
  });

  it('fails closed before create when the API does not advertise held mission support', async () => {
    mockApi.mockResolvedValueOnce({
      version: 1,
      capabilities: [],
    });

    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'manage_missions',
        {
          action: 'create',
          title: 'Held Mission',
          startMode: 'held',
        },
        createMockContext(),
      ),
    ).rejects.toThrow('does not support required mission controls: startMode');

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][0]).toBe('/api/missions/capabilities');
  });

  it('preflights and forwards held and pacing controls when the API advertises support', async () => {
    mockApi.mockResolvedValueOnce({
      version: 1,
      capabilities: ['startMode', 'pacing'],
    });
    mockApi.mockResolvedValueOnce({
      id: 'mission-1',
      title: 'Controlled Mission',
      status: 'active',
      priority: 5,
      isHeld: true,
      pacingMode: 'paced',
      pacingMaxPerHour: 120,
    });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      {
        action: 'create',
        title: 'Controlled Mission',
        startMode: 'held',
        pacingMode: 'paced',
        pacingMaxPerHour: 120,
      },
      createMockContext(),
    );

    expect(mockApi.mock.calls[0][0]).toBe('/api/missions/capabilities');
    const [endpoint, opts] = mockApi.mock.calls[1];
    expect(endpoint).toBe('/api/missions');
    expect(JSON.parse(opts.body)).toMatchObject({
      startMode: 'held',
      pacingMode: 'paced',
      pacingMaxPerHour: 120,
    });
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

describe('manage_missions — goalCriteria / evaluate / autoVerify', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('passes goalCriteria array in create body', async () => {
    const criteria = [{ type: 'all_prs_merged', requireBranchDeleted: false }];
    mockApi.mockResolvedValueOnce({
      id: 'mission-1',
      title: 'Ship v2',
      status: 'active',
      priority: 5,
    });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      { action: 'create', title: 'Ship v2', goalCriteria: criteria },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.goalCriteria).toEqual(criteria);
  });

  it('passes goalCriteria=null to clear criteria on update', async () => {
    mockApi.mockResolvedValueOnce({ id: 'mission-1', title: 'Ship v2', status: 'active' });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      { action: 'update', missionId: 'mission-1', goalCriteria: null },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.goalCriteria).toBeNull();
  });

  it('passes autoVerify=false in update body (toggling off auto-evaluation)', async () => {
    mockApi.mockResolvedValueOnce({ id: 'mission-1', title: 'Ship v2', status: 'active' });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      { action: 'update', missionId: 'mission-1', autoVerify: false },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.autoVerify).toBe(false);
  });

  it('evaluate POSTs to /api/missions/:id/evaluate and formats fail verdict with evidence', async () => {
    // Simulate the all_prs_merged criterion failing with specific branch info
    mockApi.mockResolvedValueOnce({
      goalCriteriaState: {
        overall: 'fail',
        evaluatedAt: '2026-08-08T12:00:00.000Z',
        evaluatedBy: 'mcp',
        criteria: [
          {
            index: 0,
            type: 'all_prs_merged',
            label: 'All PRs merged',
            verdict: 'fail',
            evidence: '1 PR(s) not yet merged: feature/login-overhaul (https://github.com/org/repo/pull/42)',
          },
        ],
      },
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      { action: 'evaluate', missionId: 'mission-1' },
      createMockContext(),
    );

    // Should have POSTed to the evaluate endpoint
    expect(mockApi.mock.calls[0][0]).toBe('/api/missions/mission-1/evaluate');
    expect(mockApi.mock.calls[0][1]?.method).toBe('POST');

    const text = (result as any).content[0].text;
    expect(text).toContain('fail');
    expect(text).toContain('All PRs merged');
    expect(text).toContain('1 PR(s) not yet merged');
    expect(text).toContain('feature/login-overhaul');
  });

  it('evaluate returns no-criteria message when goalCriteria is empty', async () => {
    mockApi.mockResolvedValueOnce({
      message: 'No goalCriteria set — nothing to evaluate',
      goalCriteriaState: null,
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      { action: 'evaluate', missionId: 'mission-1' },
      createMockContext(),
    );

    const text = (result as any).content[0].text;
    expect(text).toContain('No goalCriteria set');
  });

  it('get_criteria_state GETs last state without re-evaluating', async () => {
    mockApi.mockResolvedValueOnce({
      goalCriteriaState: {
        overall: 'UNVERIFIED',
        evaluatedAt: '2026-08-07T10:00:00.000Z',
        evaluatedBy: 'auto',
        criteria: [
          { index: 0, type: 'all_prs_merged', verdict: 'UNVERIFIED', evidence: 'Branch deleted status unknown' },
        ],
      },
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      { action: 'get_criteria_state', missionId: 'mission-1' },
      createMockContext(),
    );

    // Should GET (not POST) the evaluate endpoint
    expect(mockApi.mock.calls[0][0]).toBe('/api/missions/mission-1/evaluate');
    expect(mockApi.mock.calls[0][1]?.method).toBeUndefined(); // GET by default

    const text = (result as any).content[0].text;
    expect(text).toContain('UNVERIFIED');
    expect(text).toContain('auto');
  });

  it('get response includes goalCriteria section when criteria are set and evaluated', async () => {
    mockApi.mockResolvedValueOnce({
      id: 'mission-1',
      title: 'Ship v2',
      status: 'active',
      progress: 80,
      completedTasks: 4,
      totalTasks: 5,
      goalCriteria: [
        { type: 'all_prs_merged', label: 'All PRs merged', requireBranchDeleted: false },
        { type: 'no_open_tasks', label: 'No open tasks' },
      ],
      autoVerify: true,
      goalCriteriaState: {
        overall: 'fail',
        evaluatedAt: '2026-08-08T11:00:00.000Z',
        evaluatedBy: 'auto',
        criteria: [
          { index: 0, type: 'all_prs_merged', label: 'All PRs merged', verdict: 'fail', evidence: '1 PR(s) not yet merged: feature/x' },
          { index: 1, type: 'no_open_tasks', label: 'No open tasks', verdict: 'pass', evidence: null },
        ],
      },
      tasks: [],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      { action: 'get', missionId: 'mission-1' },
      createMockContext(),
    );

    const text = (result as any).content[0].text;
    expect(text).toContain('Goal criteria');
    expect(text).toContain('autoVerify=auto');
    expect(text).toContain('overall=fail');
    expect(text).toContain('All PRs merged');
    expect(text).toContain('1 PR(s) not yet merged');
    expect(text).toContain('No open tasks');
  });

  it('get response shows unevaluated criteria when no goalCriteriaState yet', async () => {
    mockApi.mockResolvedValueOnce({
      id: 'mission-2',
      title: 'New mission',
      status: 'active',
      progress: 0,
      completedTasks: 0,
      totalTasks: 0,
      goalCriteria: [{ type: 'artifact_exists', label: 'Final report', artifactType: 'report' }],
      autoVerify: false,
      goalCriteriaState: null,
      tasks: [],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      { action: 'get', missionId: 'mission-2' },
      createMockContext(),
    );

    const text = (result as any).content[0].text;
    expect(text).toContain('Goal criteria');
    expect(text).toContain('autoVerify=manual-only');
    expect(text).toContain('not yet evaluated');
    expect(text).toContain('Final report');
  });

  it('get response omits goalCriteria section when no criteria set', async () => {
    mockApi.mockResolvedValueOnce({
      id: 'mission-3',
      title: 'Plain mission',
      status: 'active',
      progress: 100,
      completedTasks: 2,
      totalTasks: 2,
      goalCriteria: [],
      goalCriteriaState: null,
      tasks: [],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'manage_missions',
      { action: 'get', missionId: 'mission-3' },
      createMockContext(),
    );

    const text = (result as any).content[0].text;
    expect(text).not.toContain('Goal criteria');
  });
});
