import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, workerActions, triggerActions, type ApiFn, type ActionContext } from '../mcp-tools';
import { mcpGroupOf } from '../mcp-tool-groups';
import { requiredScopeForAction } from '../token-scopes';

const WS = '00000000-0000-0000-0000-000000000001';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WS,
    workerId: '00000000-0000-0000-0000-000000000002',
    authType: 'oauth',
    getWorkspaceId: async () => WS,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('resolve_capability', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });

  it('is a worker-level read, not trigger-level, beside list_connectors', () => {
    expect(workerActions as readonly string[]).toContain('resolve_capability');
    expect(triggerActions as readonly string[]).not.toContain('resolve_capability');
    expect(mcpGroupOf('resolve_capability')).toBe(mcpGroupOf('list_connectors'));
    expect(requiredScopeForAction('resolve_capability')).toBe('analytics:read');
  });

  it('hits the read route with capability and role', async () => {
    api.mockResolvedValueOnce({ capability: 'observability:query', candidates: [] });
    const res = await handleBuilddAction(api as unknown as ApiFn, 'resolve_capability', { capability: ' observability:query ', roleSlug: 'builder' }, ctx());
    expect(res.isError).toBeFalsy();
    expect(api.mock.calls[0][0]).toBe(`/api/connectors/capabilities?workspaceId=${WS}&capability=observability%3Aquery&roleSlug=builder`);
    expect(api.mock.calls[0][1]).toBeUndefined();
    expect(JSON.parse(res.content[0].text).capability).toBe('observability:query');
  });

  it('without a capability it lists, and passes no role unless given', async () => {
    api.mockResolvedValueOnce({ capabilities: [] });
    await handleBuilddAction(api as unknown as ApiFn, 'resolve_capability', { capability: '  ' }, ctx());
    expect(api.mock.calls[0][0]).toBe(`/api/connectors/capabilities?workspaceId=${WS}`);
  });

  it('fails clearly when no workspace resolves', async () => {
    const noWs = ctx({ workspaceId: undefined, getWorkspaceId: async () => null });
    await expect(handleBuilddAction(api as unknown as ApiFn, 'resolve_capability', {}, noWs)).rejects.toThrow(/Cannot resolve workspace/);
    expect(api).not.toHaveBeenCalled();
  });
});

describe('request_capability', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });

  it('is a worker-level action beside resolve_capability, never trigger-level', () => {
    expect(workerActions as readonly string[]).toContain('request_capability');
    expect(triggerActions as readonly string[]).not.toContain('request_capability');
    expect(mcpGroupOf('request_capability')).toBe(mcpGroupOf('resolve_capability'));
    expect(requiredScopeForAction('request_capability')).toBe('tasks:write');
  });

  it('posts the semantic ask as this worker', async () => {
    api.mockResolvedValueOnce({ outcome: 'pending_approval', grant: { id: 'g1' } });
    const res = await handleBuilddAction(api as unknown as ApiFn, 'request_capability', { provider: 'axiom', access: 'read', reason: 'trace latency' }, ctx());
    expect(api.mock.calls[0][0]).toBe('/api/agent-capabilities/requests');
    expect(api.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ provider: 'axiom', access: 'read', reason: 'trace latency', workerId: '00000000-0000-0000-0000-000000000002' });
    expect(JSON.parse(res.content[0].text).outcome).toBe('pending_approval');
  });

  it('requires a provider and access', async () => {
    await expect(handleBuilddAction(api as unknown as ApiFn, 'request_capability', {}, ctx())).rejects.toThrow(/provider and access are required/);
    expect(api).not.toHaveBeenCalled();
  });
});

describe('invoke_model_inference', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });
  const questions = { label: { type: 'choice', instructions: 'Classify the row.', criteria: { a: null, b: null } } };

  it('is a worker-level action beside request_capability, never trigger-level', () => {
    expect(workerActions as readonly string[]).toContain('invoke_model_inference');
    expect(triggerActions as readonly string[]).not.toContain('invoke_model_inference');
    expect(mcpGroupOf('invoke_model_inference')).toBe(mcpGroupOf('request_capability'));
    expect(requiredScopeForAction('invoke_model_inference')).toBe('tasks:write');
  });

  it('posts one decision as this worker and returns the answers and receipt', async () => {
    api.mockResolvedValueOnce({ answers: { label: 'a' }, receipt: { grantId: 'g1', debitedUsd: 0.00001 } });
    const res = await handleBuilddAction(api as unknown as ApiFn, 'invoke_model_inference', { model: 'jev-1', state: 'row one', questions }, ctx());
    expect(res.isError).toBeFalsy();
    expect(api.mock.calls[0][0]).toBe('/api/agent-capabilities/model-inference');
    expect(api.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ workerId: '00000000-0000-0000-0000-000000000002', model: 'jev-1', state: 'row one', questions });
    const out = JSON.parse(res.content[0].text);
    expect(out.answers).toEqual({ label: 'a' });
    expect(out.receipt.grantId).toBe('g1');
  });

  it('passes operation through and nothing else', async () => {
    api.mockResolvedValueOnce({ answers: {}, receipt: {} });
    await handleBuilddAction(api as unknown as ApiFn, 'invoke_model_inference', { model: 'jev-1', operation: 'decide', state: 's', questions, reason: 'x' }, ctx());
    expect(Object.keys(JSON.parse(api.mock.calls[0][1].body)).sort()).toEqual(['model', 'operation', 'questions', 'state', 'workerId']);
  });

  it('refuses an endpoint, key or provider before any call', async () => {
    for (const field of ['baseURL', 'apiKey', 'endpoint', 'headers', 'provider']) {
      const res = await handleBuilddAction(api as unknown as ApiFn, 'invoke_model_inference', { model: 'jev-1', state: 's', questions, [field]: 'x' }, ctx());
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain(field);
    }
    expect(api).not.toHaveBeenCalled();
  });

  it('requires model, state and questions', async () => {
    const res = await handleBuilddAction(api as unknown as ApiFn, 'invoke_model_inference', { model: 'jev-1' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/model, state and questions/);
    expect(api).not.toHaveBeenCalled();
  });

  it('turns no_grant into the exact request_capability call to make', async () => {
    api.mockRejectedValueOnce(new Error('API error: 403 - {"error":"No live model.inference grant for this worker","code":"no_grant"}'));
    const res = await handleBuilddAction(api as unknown as ApiFn, 'invoke_model_inference', { model: 'jev-1', state: 's', questions }, ctx());
    expect(res.isError).toBe(true);
    const t = res.content[0].text;
    expect(t).toContain('no_grant');
    expect(t).toContain('request_capability');
    expect(t).toContain('"capability":"model.inference"');
    expect(t).toContain('"models":["jev-1"]');
  });

  it('keeps the receipt on a refusal that reached the provider', async () => {
    api.mockRejectedValueOnce(new Error('API error: 502 - {"error":"provider failed","code":"provider_error","receipt":{"debitedUsd":0.005}}'));
    const res = await handleBuilddAction(api as unknown as ApiFn, 'invoke_model_inference', { model: 'jev-1', state: 's', questions }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('provider_error');
    expect(res.content[0].text).toContain('"debitedUsd":0.005');
  });
});
