import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function createMockContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

function schedule(name: string, heartbeat: boolean) {
  return {
    id: `sched-${name}`,
    name,
    enabled: true,
    cronExpression: '0 * * * *',
    timezone: 'UTC',
    nextRunAt: null,
    lastRunAt: null,
    totalRuns: 0,
    consecutiveFailures: 0,
    lastError: null,
    taskTemplate: { title: `${name} task`, context: heartbeat ? { heartbeat: true } : {} },
  };
}

describe('list_schedules — type filter', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('type=heartbeat returns only heartbeat rows', async () => {
    mockApi.mockResolvedValue({
      schedules: [schedule('mission-pulse', true), schedule('nightly-digest', false)],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'list_schedules',
      { workspaceId: MOCK_WORKSPACE_ID, type: 'heartbeat' },
      createMockContext(),
    );

    const output = result.content[0].text;
    expect(output).toContain('mission-pulse');
    expect(output).not.toContain('nightly-digest');
  });

  it('type=workspace returns only non-heartbeat rows', async () => {
    mockApi.mockResolvedValue({
      schedules: [schedule('mission-pulse', true), schedule('nightly-digest', false)],
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'list_schedules',
      { workspaceId: MOCK_WORKSPACE_ID, type: 'workspace' },
      createMockContext(),
    );

    const output = result.content[0].text;
    expect(output).toContain('nightly-digest');
    expect(output).not.toContain('mission-pulse');
  });

  it('omitted type is byte-identical to explicit type="all"', async () => {
    const schedules = [schedule('mission-pulse', true), schedule('nightly-digest', false)];

    mockApi.mockResolvedValue({ schedules });
    const omitted = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'list_schedules',
      { workspaceId: MOCK_WORKSPACE_ID },
      createMockContext(),
    );

    mockApi.mockResolvedValue({ schedules });
    const explicitAll = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'list_schedules',
      { workspaceId: MOCK_WORKSPACE_ID, type: 'all' },
      createMockContext(),
    );

    expect(omitted.content[0].text).toBe(explicitAll.content[0].text);
    expect(omitted.content[0].text).toContain('mission-pulse');
    expect(omitted.content[0].text).toContain('nightly-digest');
  });

  it('type=heartbeat with no matches returns the filtered-empty message, not the unfiltered one', async () => {
    mockApi.mockResolvedValue({ schedules: [schedule('nightly-digest', false)] });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'list_schedules',
      { workspaceId: MOCK_WORKSPACE_ID, type: 'heartbeat' },
      createMockContext(),
    );

    expect(result.content[0].text).toBe('No schedules matched the filter.');
  });
});
