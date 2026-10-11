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
    const res = await handleBuilddAction(api as unknown as ApiFn, 'request_capability', { capability: 'observability:query', provider: 'axiom', reason: 'trace latency' }, ctx());
    expect(api.mock.calls[0][0]).toBe('/api/agent-capabilities/requests');
    expect(api.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ capability: 'observability:query', provider: 'axiom', reason: 'trace latency', workerId: '00000000-0000-0000-0000-000000000002' });
    expect(JSON.parse(res.content[0].text).outcome).toBe('pending_approval');
  });

  it('requires a capability', async () => {
    await expect(handleBuilddAction(api as unknown as ApiFn, 'request_capability', {}, ctx())).rejects.toThrow(/capability is required/);
    expect(api).not.toHaveBeenCalled();
  });
});
