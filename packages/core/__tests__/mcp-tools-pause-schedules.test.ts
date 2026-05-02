import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function adminContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'admin',
    ...overrides,
  };
}

function workerContext(): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'worker',
  };
}

const SAMPLE_SCHEDULES = [
  { id: 'sched-kids', name: 'Kids triage', enabled: true },
  { id: 'sched-finance', name: 'Finance summary', enabled: true },
  { id: 'sched-paused', name: 'Old triage', enabled: false },
];

function listingApi(schedules = SAMPLE_SCHEDULES): ApiFn {
  return mock(async (url: string, opts?: any) => {
    if (url.endsWith('/schedules') && (!opts || opts.method === undefined || opts.method === 'GET')) {
      return { schedules };
    }
    // PATCH single schedule
    if (opts?.method === 'PATCH') {
      return { schedule: { id: url.split('/').pop(), enabled: JSON.parse(opts.body).enabled } };
    }
    return {};
  }) as unknown as ApiFn;
}

describe('pause_schedules', () => {
  let api: ApiFn;

  beforeEach(() => {
    api = listingApi();
  });

  it('rejects non-admin tokens', async () => {
    const result = await handleBuilddAction(api, 'pause_schedules', {}, workerContext()).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('admin-level token');
  });

  it('pauses all schedules in workspace by default', async () => {
    const result = await handleBuilddAction(api, 'pause_schedules', {}, adminContext());
    const text = result.content[0].text;
    expect(text).toContain('Paused 2/2');
    expect(text).toContain('Kids triage');
    expect(text).toContain('Finance summary');
    expect(text).toContain('skipped 1');
  });

  it('filters by namePattern (case-insensitive substring)', async () => {
    const result = await handleBuilddAction(
      api,
      'pause_schedules',
      { namePattern: 'KIDS' },
      adminContext(),
    );
    const text = result.content[0].text;
    expect(text).toContain('Paused 1/1');
    expect(text).toContain('Kids triage');
    expect(text).not.toContain('Finance');
  });

  it('pauses by exact scheduleIds list', async () => {
    const result = await handleBuilddAction(
      api,
      'pause_schedules',
      { scheduleIds: ['sched-finance'] },
      adminContext(),
    );
    const text = result.content[0].text;
    expect(text).toContain('Paused 1/1');
    expect(text).toContain('Finance summary');
    expect(text).not.toContain('Kids');
  });

  it('errors when scheduleIds reference unknown schedules', async () => {
    const result = await handleBuilddAction(
      api,
      'pause_schedules',
      { scheduleIds: ['ghost-id'] },
      adminContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('resumes when enabled:true is passed', async () => {
    const result = await handleBuilddAction(
      api,
      'pause_schedules',
      { scheduleIds: ['sched-paused'], enabled: true },
      adminContext(),
    );
    const text = result.content[0].text;
    expect(text).toContain('Resumed 1/1');
    expect(text).toContain('Old triage');
  });

  it('reports a no-op when targets are already in the desired state', async () => {
    const result = await handleBuilddAction(
      api,
      'pause_schedules',
      { scheduleIds: ['sched-paused'] },
      adminContext(),
    );
    const text = result.content[0].text;
    expect(text).toContain('already paused');
    expect(text).toContain('No changes');
  });

  it('returns empty-result message when namePattern matches nothing', async () => {
    const result = await handleBuilddAction(
      api,
      'pause_schedules',
      { namePattern: 'nonexistent' },
      adminContext(),
    );
    expect(result.content[0].text).toContain('No schedules matching');
  });

  it('issues exactly one PATCH per schedule that needs flipping', async () => {
    const tracker = mock(async (url: string, opts?: any) => {
      if (url.endsWith('/schedules') && (!opts?.method || opts.method === 'GET')) {
        return { schedules: SAMPLE_SCHEDULES };
      }
      return { schedule: { id: 'x', enabled: false } };
    });
    await handleBuilddAction(
      tracker as unknown as ApiFn,
      'pause_schedules',
      {},
      adminContext(),
    );
    // 1 list call + 2 PATCH calls (sched-paused already paused → skipped)
    expect(tracker).toHaveBeenCalledTimes(3);
    const patchCalls = tracker.mock.calls.filter((c: any[]) => c[1]?.method === 'PATCH');
    expect(patchCalls).toHaveLength(2);
    for (const [, opts] of patchCalls) {
      expect(JSON.parse(opts.body).enabled).toBe(false);
    }
  });
});
