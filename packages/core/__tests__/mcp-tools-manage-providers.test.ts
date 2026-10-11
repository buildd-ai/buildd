import { describe, it, expect, mock } from 'bun:test';
import {
  handleBuilddAction,
  workerActions,
  adminActions,
  triggerActions,
  PROVIDER_OPS,
  type ApiFn,
  type ActionContext,
} from '../mcp-tools';
import { modelCredentialPurposes } from '../providers/manage';
import { providerDescriptor } from '../providers';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const SECRET = 'sk-ant-api03-FIXTURE-core-handler-value-9876';

function ctx(level: 'trigger' | 'worker' | 'admin', principal?: ActionContext['principal']): ActionContext {
  return { workspaceId: WS_ID, getWorkspaceId: async () => WS_ID, getLevel: async () => level, ...(principal ? { principal } : {}) };
}

function recordingApi(response: unknown = {}) {
  const calls: { endpoint: string; options?: RequestInit }[] = [];
  const api = mock(async (endpoint: string, options?: RequestInit) => {
    calls.push({ endpoint, options });
    return typeof response === 'function' ? (response as any)(endpoint, options) : response;
  }) as unknown as ApiFn;
  return { api, calls };
}
const textOf = (r: { content: Array<{ text: string }> }) => r.content.map(c => c.text).join('\n');
const body = (c: { options?: RequestInit }) => JSON.parse(String(c.options?.body ?? '{}'));

const listing = {
  teamId: 't-1', workspaceId: WS_ID,
  caller: { principal: 'person', canSetMine: true },
  policy: { credentialPolicy: null, chat: { policy: 'personal_first' }, agent: { policy: 'team', enforced: false } },
  providers: [{
    id: 'openai', label: 'OpenAI',
    surfaces: providerDescriptor('openai').surfaces,
    scopes: { team: { ok: true }, workspace: { ok: true }, mine: { ok: true } },
    set: {
      team: [{ shape: 'api_key', scope: 'team', purpose: 'openai_api_key', label: null, legacy: true, last4: 'abcd', health: 'healthy', lastVerifiedAt: '2026-10-01T10:00:00.000Z', servesToday: ['agent-codex'] }],
      workspace: [],
      mine: [],
    },
  }],
};

describe('manage_providers — levels and principals', () => {
  it('is a worker action, not trigger or admin', () => {
    expect(workerActions as readonly string[]).toContain('manage_providers');
    expect(triggerActions as readonly string[]).not.toContain('manage_providers');
    expect(adminActions as readonly string[]).not.toContain('manage_providers');
    expect([...PROVIDER_OPS]).toEqual(['list', 'set', 'delete', 'explain', 'set_policy']);
  });

  it('a trigger token is refused before any API call', async () => {
    const { api, calls } = recordingApi();
    expect((await handleBuilddAction(api, 'manage_providers', { action: 'list' }, ctx('trigger'))).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown sub-action and an unknown scope', async () => {
    const { api } = recordingApi();
    await expect(handleBuilddAction(api, 'manage_providers', { action: 'verify' }, ctx('admin'))).rejects.toThrow(/action must be one of/);
    await expect(handleBuilddAction(api, 'manage_providers', { action: 'set', provider: 'anthropic', scope: 'account' }, ctx('admin'))).rejects.toThrow(/scope must be/);
  });

  it('worker level: team/workspace writes and set_policy are forbidden; mine is open to a person', async () => {
    const { api, calls } = recordingApi({ credentials: [] });
    for (const params of [
      { action: 'set', provider: 'anthropic', scope: 'team', value: SECRET },
      { action: 'delete', provider: 'anthropic', scope: 'workspace' },
      { action: 'set_policy', policy: 'team' },
    ]) {
      const r = await handleBuilddAction(api, 'manage_providers', params, ctx('worker', 'person'));
      expect(JSON.parse(textOf(r))).toMatchObject({ error: 'forbidden', requiredLevel: 'admin' });
    }
    expect(calls).toHaveLength(0);
    const ok = await handleBuilddAction(api, 'manage_providers', { action: 'set', provider: 'anthropic', value: SECRET }, ctx('worker', 'person'));
    expect(ok.isError).toBeUndefined();
    expect(body(calls[0])).toMatchObject({ provider: 'anthropic', scope: 'mine', value: SECRET });
  });

  it('a key or a task token never writes mine; a task token never writes at all', async () => {
    const { api, calls } = recordingApi();
    const key = await handleBuilddAction(api, 'manage_providers', { action: 'set', provider: 'anthropic', scope: 'mine', value: SECRET }, ctx('admin', 'key'));
    expect(textOf(key)).toContain('API key has no person');
    for (const scope of ['mine', 'team']) {
      const tok = await handleBuilddAction(api, 'manage_providers', { action: 'set', provider: 'anthropic', scope, value: SECRET }, ctx('admin', 'task_token'));
      expect(tok.isError).toBe(true);
      expect(textOf(tok)).toContain('per-task token');
    }
    expect(calls).toHaveLength(0);
  });

  it('defaults scope to team for anyone but a person', async () => {
    const { api, calls } = recordingApi({ credentials: [] });
    await handleBuilddAction(api, 'manage_providers', { action: 'set', provider: 'anthropic', value: SECRET }, ctx('admin', 'key'));
    expect(body(calls[0]).scope).toBe('team');
  });
});

describe('manage_providers — requests and rendering', () => {
  it('list renders what each provider serves, the registry reason for what it cannot, and rows by last four', async () => {
    const { api, calls } = recordingApi(listing);
    const out = textOf(await handleBuilddAction(api, 'manage_providers', { action: 'list' }, ctx('worker', 'person')));
    expect(calls[0].endpoint).toBe(`/api/providers?workspaceId=${WS_ID}`);
    const reason = (providerDescriptor('openai').surfaces['agent-claude'] as { reason: string }).reason;
    expect(out).toContain(reason);
    expect(out).toContain('…abcd healthy');
    expect(out).toContain('legacy storage');
    expect(out).toContain('serves agent-codex');
  });

  it('set with scope workspace sends the workspace; the response never repeats the value', async () => {
    const { api, calls } = recordingApi({ provider: 'anthropic', scope: 'workspace', workspaceId: WS_ID, credentials: [{ shape: 'api_key', scope: 'workspace', purpose: 'anthropic_api_key', label: null, legacy: true, last4: '9876', health: 'healthy', lastVerifiedAt: null, servesToday: ['chat'] }], requeued: 2 });
    const out = textOf(await handleBuilddAction(api, 'manage_providers', { action: 'set', provider: 'anthropic', scope: 'workspace', value: SECRET }, ctx('admin', 'person')));
    expect(body(calls[0])).toMatchObject({ provider: 'anthropic', scope: 'workspace', workspaceId: WS_ID, value: SECRET });
    expect(out).toContain('…9876');
    expect(out).toContain('Requeued 2');
    expect(out).not.toContain(SECRET);
  });

  it('delete goes to DELETE /api/providers with the scope', async () => {
    const { api, calls } = recordingApi({ deleted: 1, credentials: [] });
    const out = textOf(await handleBuilddAction(api, 'manage_providers', { action: 'delete', provider: 'openrouter', scope: 'mine' }, ctx('worker', 'person')));
    expect(calls[0].endpoint).toBe('/api/providers?provider=openrouter&scope=mine');
    expect(calls[0].options?.method).toBe('DELETE');
    expect(out).toContain('Removed 1');
  });

  it('explain needs a surface and renders the winner and why', async () => {
    const { api, calls } = recordingApi({
      surface: 'chat', as: 'self', workspaceId: WS_ID,
      result: { resolved: true, provider: 'anthropic', shape: 'api_key', scope: 'personal', source: { scope: 'personal', secretId: 'sec-1', purpose: 'inference_key', label: 'anthropic', legacy: false } },
      why: ['policy: personal_first [from default]'],
    });
    await expect(handleBuilddAction(api, 'manage_providers', { action: 'explain' }, ctx('worker'))).rejects.toThrow(/surface is required/);
    const out = textOf(await handleBuilddAction(api, 'manage_providers', { action: 'explain', surface: 'chat' }, ctx('worker', 'person')));
    expect(calls[0].endpoint).toBe(`/api/providers/explain?surface=chat&workspaceId=${WS_ID}`);
    expect(out).toContain('chat (your work) → anthropic api_key, personal row sec-1');
    expect(out).toContain('- policy: personal_first');
  });

  it('set_policy PATCHes the policy (admin)', async () => {
    const { api, calls } = recordingApi({ policy: { credentialPolicy: 'personal_first' } });
    await expect(handleBuilddAction(api, 'manage_providers', { action: 'set_policy', policy: 'own' }, ctx('admin'))).rejects.toThrow(/policy is required/);
    await handleBuilddAction(api, 'manage_providers', { action: 'set_policy', policy: 'personal_first' }, ctx('admin'));
    expect(calls[0].options?.method).toBe('PATCH');
    expect(body(calls[0])).toEqual({ credentialPolicy: 'personal_first' });
  });
});

describe('manage_secrets — model purposes have one write path', () => {
  it.each(modelCredentialPurposes())('refuses set with purpose %s and points to manage_providers', async (purpose) => {
    const { api, calls } = recordingApi();
    const r = await handleBuilddAction(api, 'manage_secrets', { action: 'set', purpose, label: 'X', value: SECRET }, ctx('admin'));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('manage_providers');
    expect(calls).toHaveLength(0);
  });

  it('still stores an MCP credential', async () => {
    const { api, calls } = recordingApi({ id: 'sec-9' });
    await handleBuilddAction(api, 'manage_secrets', { action: 'set', label: 'TOKEN', value: 'v' }, ctx('admin'));
    expect(body(calls[0])).toEqual({ value: 'v', purpose: 'mcp_credential', label: 'TOKEN' });
  });
});
