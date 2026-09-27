/**
 * manage_model_tiers: the optional `surface` param on set/delete, and list
 * showing each surface when a tier is split.
 */
import { describe, it, expect, mock } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';

const ctx: ActionContext = {
  workspaceId: WS_ID,
  getWorkspaceId: async () => WS_ID,
  getLevel: async () => 'admin',
};

function apiReturning(data: unknown) {
  const fn = mock(async (_path: string, _init?: RequestInit) => data);
  return { fn, api: fn as unknown as ApiFn };
}

describe('manage_model_tiers surface', () => {
  it('set passes surface in the body', async () => {
    const { fn, api } = apiReturning({ ok: true });
    const res = await handleBuilddAction(api, 'manage_model_tiers', {
      action: 'set', tier: 'standard', provider: 'anthropic', model: 'claude-sonnet-5', surface: 'chat',
    }, ctx);
    expect(res.isError).toBeFalsy();
    const [path, init] = fn.mock.calls[0];
    expect(path).toBe('/api/model-tiers');
    expect(JSON.parse(String(init!.body))).toMatchObject({ tier: 'standard', surface: 'chat' });
    expect(res.content[0].text).toContain('chat only');
  });

  it('set without surface writes the shared row', async () => {
    const { fn, api } = apiReturning({ ok: true });
    await handleBuilddAction(api, 'manage_model_tiers', {
      action: 'set', tier: 'standard', provider: 'anthropic', model: 'claude-sonnet-5',
    }, ctx);
    expect(JSON.parse(String(fn.mock.calls[0][1]!.body)).surface).toBeUndefined();
  });

  it('set rejects an unknown surface without calling the API', async () => {
    const { fn, api } = apiReturning({ ok: true });
    const res = await handleBuilddAction(api, 'manage_model_tiers', {
      action: 'set', tier: 'standard', provider: 'anthropic', model: 'm', surface: 'web',
    }, ctx).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
    expect(res.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('delete passes surface in the query', async () => {
    const { fn, api } = apiReturning({ ok: true });
    await handleBuilddAction(api, 'manage_model_tiers', { action: 'delete', tier: 'budget', surface: 'agent' }, ctx);
    const qs = new URLSearchParams(String(fn.mock.calls[0][0]).split('?')[1]);
    expect(qs.get('tier')).toBe('budget');
    expect(qs.get('surface')).toBe('agent');
  });

  it('list shows one line per surface for a split tier and one line otherwise', async () => {
    const shared = { provider: 'anthropic', model: 'claude-haiku-4-5', source: 'team' };
    const { api } = apiReturning({
      budget: { ...shared, bySurface: { agent: shared, chat: shared } },
      standard: {
        provider: 'anthropic', model: 'claude-sonnet-5', source: 'team',
        bySurface: {
          agent: { provider: 'openai-codex', model: 'gpt-5.6-codex', source: 'team', surface: 'agent' },
          chat: { provider: 'anthropic', model: 'claude-sonnet-5', source: 'team' },
        },
      },
    });
    const res = await handleBuilddAction(api, 'manage_model_tiers', { action: 'list' }, ctx);
    const out = res.content[0].text;
    expect(out).toContain('budget: claude-haiku-4-5');
    expect(out).toContain('agent: gpt-5.6-codex');
    expect(out).toContain('chat: claude-sonnet-5');
  });
});
