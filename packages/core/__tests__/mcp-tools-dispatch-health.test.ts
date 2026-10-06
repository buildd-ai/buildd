import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, workerActions, triggerActions, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';
import { emptyTeamHealth, type DispatchHealthReport } from '../dispatch-health-report';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const TASK_ID = '11111111-1111-1111-1111-111111111111';

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  workspaceId: WS_ID,
  getWorkspaceId: async () => WS_ID,
  getLevel: async () => 'worker',
  ...over,
});

const REPORT: DispatchHealthReport = {
  generatedAt: '2026-10-04T12:00:00.000Z',
  healthy: false,
  verdict: 'Dispatch Worker unreachable (timeout)',
  problems: ['Dispatch Worker unreachable (timeout)'],
  outbox: { ...emptyTeamHealth(), pending: 2, handedOff: 1 },
  workspaces: [{ id: WS_ID, name: 'alpha', transport: 'dispatch' }],
  worker: { status: 'unreachable', error: 'timeout' },
  lastRepair: null,
};

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0].text);

describe('dispatch_health', () => {
  it('is a worker-level read, not a trigger-level one', () => {
    expect((workerActions as readonly string[]).includes('dispatch_health')).toBe(true);
    expect((triggerActions as readonly string[]).includes('dispatch_health')).toBe(false);
  });

  it('team-wide by default: no workspaceId sent, so the route scopes to the key\'s team', async () => {
    const api = mock(async (_e: string) => REPORT);
    const out = textOf(await handleBuilddAction(api as unknown as ApiFn, 'dispatch_health', {}, ctx()));
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0][0]).toBe('/api/health/dispatch');
    expect(out.split('\n')[0]).toBe('Dispatch: Dispatch Worker unreachable (timeout)');
    expect(out).toContain('Outbox (1 workspace): pending 2');
    expect(out).toContain('Last floor run: none recorded');
  });

  it('one workspace when asked', async () => {
    const api = mock(async (_e: string) => REPORT);
    await handleBuilddAction(api as unknown as ApiFn, 'dispatch_health', { workspaceId: WS_ID }, ctx());
    expect(api.mock.calls[0][0]).toBe(`/api/health/dispatch?workspaceId=${WS_ID}`);
  });

  it('is documented', () => {
    const doc = buildParamsDescription(['dispatch_health']);
    expect(doc).toContain('dispatch_health');
    expect(doc).toContain('workspaceId?');
    expect(doc).toContain('verdict');
  });
});

describe('get_task include:["dispatch"]', () => {
  it('asks the route for the trail and renders one line per intent', async () => {
    const api = mock(async (_e: string) => ({
      id: TASK_ID, title: 'Fix bug', status: 'pending', priority: 0,
      dispatch: [
        { id: 'o-1', intent: 'work_execution', cause: 'task.created', causes: ['task.created'], status: 'delivered', transport: 'dispatch',
          notBefore: '2026-10-04T12:00:00.000Z', handedOffAt: '2026-10-04T12:00:01.000Z', deliveredAt: '2026-10-04T12:00:02.000Z',
          deliveredVia: 'webhook', attemptCount: 1, lastError: null, createdAt: '2026-10-04T12:00:00.000Z' },
        { id: 'o-2', intent: 'work_execution', cause: 'ci.retry', causes: ['ci.retry'], status: 'failed', transport: 'dispatch',
          notBefore: '2026-10-04T13:00:00.000Z', handedOffAt: '2026-10-04T13:00:01.000Z', deliveredAt: null,
          deliveredVia: null, attemptCount: 5, lastError: 'http_500', createdAt: '2026-10-04T13:00:00.000Z' },
      ],
    }));
    const out = textOf(await handleBuilddAction(api as unknown as ApiFn, 'get_task', { taskId: TASK_ID, include: ['dispatch'] }, ctx()));
    const url = new URL(api.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.get('include')).toBe('dispatch');
    expect(out).toContain('## Dispatch (2)');
    expect(out).toContain('- o-1 task.created: delivered via webhook · dispatch · handed off 2026-10-04T12:00:01.000Z · 1 attempt');
    expect(out).toContain('- o-2 ci.retry: failed · dispatch · handed off 2026-10-04T13:00:01.000Z · 5 attempts · last error: http_500');
  });

  it('an empty trail says so', async () => {
    const api = mock(async (_e: string) => ({ id: TASK_ID, title: 't', status: 'pending', dispatch: [] }));
    const out = textOf(await handleBuilddAction(api as unknown as ApiFn, 'get_task', { taskId: TASK_ID, include: ['dispatch'] }, ctx()));
    expect(out).toContain('## Dispatch (0)\nNo dispatch intents recorded.');
  });
});
