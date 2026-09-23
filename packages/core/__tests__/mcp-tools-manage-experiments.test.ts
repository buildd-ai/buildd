import { describe, it, expect, mock } from 'bun:test';
import {
  handleBuilddAction,
  workerActions,
  adminActions,
  triggerActions,
  EXPERIMENT_WRITE_OPS,
  EXPERIMENT_READ_OPS,
  type ApiFn,
  type ActionContext,
} from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const EXP_ID = '11111111-1111-4111-8111-111111111111';

function ctx(level: 'trigger' | 'worker' | 'admin'): ActionContext {
  return { workspaceId: WS_ID, getWorkspaceId: async () => WS_ID, getLevel: async () => level };
}

const experiment = (over: Record<string, unknown> = {}) => ({
  id: EXP_ID, key: 'premium-vs-standard', title: 'Premium vs standard', hypothesis: null,
  status: 'draft', kind: 'model_routing', treatmentFraction: 0.5, policyVersion: 1, config: {},
  visibility: 'team', decision: null, startedAt: null, concludedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});

function recordingApi(response: unknown = {}) {
  const calls: { endpoint: string; options?: RequestInit }[] = [];
  const api = mock(async (endpoint: string, options?: RequestInit) => {
    calls.push({ endpoint, options });
    return typeof response === 'function' ? (response as any)(endpoint, options) : response;
  }) as unknown as ApiFn;
  return { api, calls };
}

describe('manage_experiments — level gating', () => {
  it('is advertised at worker level, not trigger, and not duplicated into adminActions', () => {
    expect(workerActions as readonly string[]).toContain('manage_experiments');
    expect(triggerActions as readonly string[]).not.toContain('manage_experiments');
    expect(adminActions as readonly string[]).not.toContain('manage_experiments');
  });

  it('trigger tokens are refused before any API call', async () => {
    const { api, calls } = recordingApi();
    const r = await handleBuilddAction(api, 'manage_experiments', { action: 'list' }, ctx('trigger'));
    expect(r.isError).toBe(true);
    expect(calls.length).toBe(0);
  });

  it.each([...EXPERIMENT_WRITE_OPS])('worker token: %s is a structured forbidden, no API call', async (op) => {
    const { api, calls } = recordingApi();
    const r = await handleBuilddAction(api, 'manage_experiments', { action: op, experimentId: EXP_ID, key: 'k', title: 't', decision: 'd' }, ctx('worker'));
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toBe('forbidden');
    expect(body.requiredLevel).toBe('admin');
    expect(body.tokenLevel).toBe('worker');
    expect(calls.length).toBe(0);
  });

  it.each([...EXPERIMENT_READ_OPS])('worker token: %s reaches the API (which filters by visibility)', async (op) => {
    const { api, calls } = recordingApi({
      experiments: [], canManage: false, experiment: experiment(), policyVersion: 1,
      readout: {
        minSamplePerArm: 30, verdict: 'insufficient_n', difference: null, inheritedExcluded: 0,
        control: { n: 0, assigned: 0, pending: 0, cleanRate: null, cleanInterval: { lower: 0, upper: 1 }, servedRate: null },
        treatment: { n: 0, assigned: 0, pending: 0, cleanRate: null, cleanInterval: { lower: 0, upper: 1 }, servedRate: null },
      },
    });
    const r = await handleBuilddAction(api, 'manage_experiments', { action: op, experimentId: EXP_ID }, ctx('worker'));
    expect(r.isError).toBeFalsy();
    expect(calls.length).toBe(1);
    expect(calls[0].endpoint).toContain(`workspaceId=${WS_ID}`);
  });

  it('a hidden (admins-only) experiment surfaces as the API 404, not as forbidden', async () => {
    const api = (async () => { throw new Error('API error: 404 - {"error":"Experiment not found"}'); }) as unknown as ApiFn;
    await expect(handleBuilddAction(api, 'manage_experiments', { action: 'get', experimentId: EXP_ID }, ctx('worker')))
      .rejects.toThrow('404');
  });

  it('rejects an unknown sub-action', async () => {
    const { api } = recordingApi();
    await expect(handleBuilddAction(api, 'manage_experiments', { action: 'delete' }, ctx('admin'))).rejects.toThrow('action must be one of');
  });
});

describe('manage_experiments — admin dispatch', () => {
  it('create POSTs a draft and says nothing enrolls until start', async () => {
    const { api, calls } = recordingApi({ experiment: experiment() });
    const r = await handleBuilddAction(api, 'manage_experiments', {
      action: 'create', key: 'premium-vs-standard', title: 'Premium vs standard', treatmentFraction: 0.3, visibility: 'team',
    }, ctx('admin'));
    expect(calls[0].endpoint).toBe(`/api/experiments?workspaceId=${WS_ID}`);
    expect(calls[0].options?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].options?.body))).toEqual({
      key: 'premium-vs-standard', title: 'Premium vs standard', treatmentFraction: 0.3, visibility: 'team',
    });
    expect(r.content[0].text).toContain('Nothing enrolls until');
  });

  it.each([
    ['start', { status: 'running' }],
    ['pause', { status: 'paused' }],
    ['conclude', { status: 'concluded', decision: 'Keep routing as is.' }],
  ] as const)('%s PATCHes the status', async (op, expected) => {
    const { api, calls } = recordingApi({ experiment: experiment({ status: expected.status }), policyVersionBumped: false });
    await handleBuilddAction(api, 'manage_experiments', { action: op, experimentId: EXP_ID, decision: 'Keep routing as is.' }, ctx('admin'));
    expect(calls[0].endpoint).toBe(`/api/experiments/${EXP_ID}?workspaceId=${WS_ID}`);
    expect(calls[0].options?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].options?.body))).toEqual(expected);
  });

  it('conclude without a decision fails before the API', async () => {
    const { api, calls } = recordingApi();
    await expect(handleBuilddAction(api, 'manage_experiments', { action: 'conclude', experimentId: EXP_ID }, ctx('admin'))).rejects.toThrow('decision');
    expect(calls.length).toBe(0);
  });

  it('update forwards only the editable fields and reports a policyVersion bump', async () => {
    const { api, calls } = recordingApi({ experiment: experiment({ status: 'running', policyVersion: 2 }), policyVersionBumped: true });
    const r = await handleBuilddAction(api, 'manage_experiments', {
      action: 'update', experimentId: EXP_ID, treatmentFraction: 0.25, status: 'concluded',
    }, ctx('admin'));
    expect(JSON.parse(String(calls[0].options?.body))).toEqual({ treatmentFraction: 0.25 });
    expect(r.content[0].text).toContain('policyVersion bumped to v2');
  });

  it('readout says "insufficient data" plainly and passes policyVersion through', async () => {
    const { api, calls } = recordingApi({
      experiment: experiment(), policyVersion: 1,
      readout: {
        minSamplePerArm: 30, verdict: 'insufficient_n', difference: null, inheritedExcluded: 0,
        control: { n: 3, assigned: 4, pending: 1, cleanRate: 2 / 3, cleanInterval: { lower: 0.2, upper: 0.9 }, servedRate: 1 },
        treatment: { n: 2, assigned: 2, pending: 0, cleanRate: 0.5, cleanInterval: { lower: 0.1, upper: 0.9 }, servedRate: 1 },
      },
    });
    const r = await handleBuilddAction(api, 'manage_experiments', { action: 'readout', experimentId: EXP_ID, policyVersion: 1 }, ctx('admin'));
    expect(calls[0].endpoint).toBe(`/api/experiments/${EXP_ID}/readout?workspaceId=${WS_ID}&policyVersion=1`);
    expect(r.content[0].text).toContain('insufficient data');
  });

  it('get/update require a full experimentId', async () => {
    const { api } = recordingApi();
    await expect(handleBuilddAction(api, 'manage_experiments', { action: 'get', experimentId: '1111' }, ctx('admin'))).rejects.toThrow('experimentId');
  });
});
