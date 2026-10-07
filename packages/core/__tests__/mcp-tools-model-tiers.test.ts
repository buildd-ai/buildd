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

describe('manage_model_tiers upgrade policy', () => {
  const report = {
    policy: { mode: 'manual', adoptedThrough: '2026-10-01T00:00:00.000Z' },
    source: 'team',
    tiers: [
      {
        tier: 'budget', model: 'claude-haiku-4-5', selectedBy: 'catalog',
        why: 'Newest model in this tier’s price band allowed by the manual upgrade policy.',
        newer: { model: 'claude-haiku-5-5', certifiedAt: '2026-10-05T00:00:00.000Z' },
        withheld: { reason: 'manual', eligibleAt: null }, deprecated: null,
      },
      {
        tier: 'premium', model: 'claude-opus-5', selectedBy: 'pinned_team', why: 'Pinned for the team.',
        newer: null, withheld: null,
        deprecated: { source: 'catalog', at: '2026-10-07T00:00:00.000Z', retiresAt: '2026-12-01T00:00:00.000Z', retired: false },
      },
    ],
  };

  it('policy reads the effective policy, its source, and why each tier runs its model', async () => {
    const { fn, api } = apiReturning(report);
    const res = await handleBuilddAction(api, 'manage_model_tiers', { action: 'policy' }, ctx);
    expect(String(fn.mock.calls[0][0])).toBe('/api/model-tiers/policy?');
    const t = res.content[0].text;
    expect(t).toContain('manual');
    expect(t).toContain('set for the team');
    expect(t).toContain('Newer certified: claude-haiku-5-5 (withheld: manual upgrade policy');
    expect(t).toContain('Deprecated (retires 2026-12-01)');
    expect(t).toContain('action=adopt');
  });

  it('set_policy writes the team policy unless a workspace is named explicitly', async () => {
    const { fn, api } = apiReturning({ policy: { mode: 'soak', soakHours: 24 }, scope: 'team' });
    const res = await handleBuilddAction(api, 'manage_model_tiers', { action: 'set_policy', mode: 'soak', soakHours: 24 }, ctx);
    const [path, init] = fn.mock.calls[0];
    expect(path).toBe('/api/model-tiers/policy');
    expect(init!.method).toBe('PUT');
    expect(JSON.parse(String(init!.body))).toEqual({ mode: 'soak', soakHours: 24 });
    expect(res.content[0].text).toContain('soak 24h');
  });

  it('set_policy inherit clears the workspace level', async () => {
    const { fn, api } = apiReturning({ ok: true });
    await handleBuilddAction(api, 'manage_model_tiers', { action: 'set_policy', mode: 'inherit', workspaceId: WS_ID }, ctx);
    expect(String(fn.mock.calls.at(-1)![0])).toBe(`/api/model-tiers/policy?workspaceId=${WS_ID}`);
    expect(fn.mock.calls.at(-1)![1]!.method).toBe('DELETE');
  });

  it('set_policy refuses "pinned" and points at action=set', async () => {
    const { fn, api } = apiReturning({});
    const res = await handleBuilddAction(api, 'manage_model_tiers', { action: 'set_policy', mode: 'pinned' }, ctx)
      .catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('action=set');
    expect(fn).not.toHaveBeenCalled();
  });

  it('adopt posts to the adopt route', async () => {
    const { fn, api } = apiReturning({ policy: { mode: 'manual', adoptedThrough: '2026-10-07T12:00:00.000Z' } });
    const res = await handleBuilddAction(api, 'manage_model_tiers', { action: 'adopt' }, ctx);
    expect(fn.mock.calls[0][0]).toBe('/api/model-tiers/policy/adopt');
    expect(res.content[0].text).toContain('2026-10-07 12:00');
  });

  it('model shows certification and deprecation state', async () => {
    const { fn, api } = apiReturning({
      certification: {
        model: 'claude-haiku-5-5', state: 'certified', minCliVersion: '2.1.290', certifiedAt: '2026-10-05T00:00:00.000Z',
        releasedAt: '2026-10-04T00:00:00.000Z', contextLength: 200000, deprecated: null, retired: false,
        lastProbe: { at: '2026-10-05T00:00:00.000Z', cliVersion: '2.1.290', error: null, attempts: 1 },
      },
    });
    const res = await handleBuilddAction(api, 'manage_model_tiers', { action: 'model', model: 'claude-haiku-5-5' }, ctx);
    expect(String(fn.mock.calls[0][0])).toBe('/api/model-tiers/certifications?model=claude-haiku-5-5');
    expect(res.content[0].text).toContain('certified');
    expect(res.content[0].text).toContain('Claude Code 2.1.290 or newer');
  });
});
