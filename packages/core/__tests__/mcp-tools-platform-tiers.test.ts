/**
 * manage_platform_tiers: the MCP face of the platform tier default. It only
 * renders and forwards; the route behind /api/model-tiers/platform decides.
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

const facts = (over: Partial<{ price: { input: number; output: number } | null; floor: string | null; certification: string; certified: boolean }> = {}) => ({
  price: { input: 8, output: 40 }, floor: '2.1.321', certification: 'baseline', certified: true, ...over,
});

const view = {
  catalogChecked: true,
  canWrite: true,
  tiers: [
    {
      tier: 'premium-plus', band: { minInput: 8, maxInput: 20 },
      effective: { provider: 'anthropic', model: 'claude-fable-5-1', source: 'platform', facts: facts({ price: { input: 10, output: 50 }, floor: '2.1.251' }) },
      platform: { model: 'claude-fable-5-1', setAt: '2026-11-14T10:00:00.000Z', setBy: { via: 'ui', accountId: null, userId: 'op-1' }, reason: 'hold', previous: { model: 'claude-fable-5' } },
      suggestion: { kind: 'newer', newer: 'claude-fable-5-2', applicable: true, needsBandConfirm: false, why: 'A newer model exists for this tier: claude-fable-5-2 ($8 in / $40 out per MTok, Claude Code 2.1.321 or newer).' },
      canRevert: true,
    },
    {
      tier: 'premium', band: { minInput: 4, maxInput: 8 },
      effective: { provider: 'anthropic', model: 'claude-opus-5-5', source: 'catalog', facts: facts({ price: { input: 4, output: 20 }, floor: '2.1.280' }) },
      platform: null, suggestion: null, canRevert: false,
    },
  ],
};

describe('manage_platform_tiers list', () => {
  it('shows per tier the effective model, source, price, floor, the stored row, the suggestion and how to act', async () => {
    const { fn, api } = apiReturning(view);
    const res = await handleBuilddAction(api, 'manage_platform_tiers', { action: 'list' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(fn.mock.calls[0][0]).toBe('/api/model-tiers/platform');
    const out = res.content[0].text;
    expect(out).toContain('premium-plus: claude-fable-5-1 (source: platform default, $10 in / $50 out per MTok, Claude Code 2.1.251 or newer');
    expect(out).toContain('via ui by user op-1: hold (revert restores claude-fable-5)');
    expect(out).toContain('suggestion: A newer model exists for this tier: claude-fable-5-2');
    expect(out).toContain('action=apply tier=premium-plus confirm=true');
    expect(out).toContain('premium: claude-opus-5-5 (source: catalog pick (newest certified in band)');
    expect(out).toContain('action=set tier=<tier> model=<id> confirm=true');
  });

  it('a read-only caller is told who can change them', async () => {
    const { api } = apiReturning({ ...view, canWrite: false, catalogChecked: false });
    const out = (await handleBuilddAction(api, 'manage_platform_tiers', { action: 'list' }, ctx)).content[0].text;
    expect(out).toContain('Read-only for this caller');
    expect(out).toContain('catalog could not be read');
  });
});

describe('manage_platform_tiers writes', () => {
  const result = {
    ok: true, op: 'set', tier: 'premium-plus', before: { model: 'claude-fable-5-1' }, after: { model: 'claude-fable-5-2' },
    effective: { model: 'claude-fable-5-2', source: 'platform' }, facts: facts(),
  };

  it('set forwards op, tier, model, confirm flags, reason and via=mcp to the route and reports before → after', async () => {
    const { fn, api } = apiReturning(result);
    const res = await handleBuilddAction(api, 'manage_platform_tiers', {
      action: 'set', tier: 'premium-plus', model: ' claude-fable-5-2 ', confirm: true, confirmBandChange: true, reason: 'move the fleet',
    }, ctx);
    expect(res.isError).toBeFalsy();
    const [path, init] = fn.mock.calls[0];
    expect(path).toBe('/api/model-tiers/platform');
    expect(init!.method).toBe('PUT');
    expect(JSON.parse(String(init!.body))).toEqual({ op: 'set', tier: 'premium-plus', model: 'claude-fable-5-2', confirm: true, confirmBandChange: true, reason: 'move the fleet', via: 'mcp' });
    expect(res.content[0].text).toContain('claude-fable-5-1 → claude-fable-5-2');
    expect(res.content[0].text).toContain('action=revert tier=premium-plus confirm=true');
  });

  it('never invents a confirm: an unconfirmed call reaches the route without one', async () => {
    const { fn, api } = apiReturning(result);
    await handleBuilddAction(api, 'manage_platform_tiers', { action: 'clear', tier: 'premium' }, ctx);
    const body = JSON.parse(String(fn.mock.calls[0][1]!.body));
    expect(body).toEqual({ op: 'clear', tier: 'premium', via: 'mcp' });
    expect('confirm' in body).toBe(false);
  });

  it('a route refusal surfaces its code and message with the next step', async () => {
    const api = (async () => {
      throw new Error('API error: 409 - ' + JSON.stringify({ error: 'This changes the premium model for every team without its own row; pass confirm: true to apply it.', code: 'confirm_required' }));
    }) as unknown as ApiFn;
    const res = await handleBuilddAction(api, 'manage_platform_tiers', { action: 'revert', tier: 'premium' }, ctx)
      .catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('refused (confirm_required)');
    expect(res.content[0].text).toContain('confirm=true');
  });

  it('refuses a missing tier or model before calling the route', async () => {
    const { fn, api } = apiReturning(result);
    for (const params of [{ action: 'set', model: 'x' }, { action: 'set', tier: 'premium' }, { action: 'revert' }, { action: 'destroy', tier: 'premium' }]) {
      const res = await handleBuilddAction(api, 'manage_platform_tiers', params, ctx).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
      expect({ params, isError: res.isError }).toEqual({ params, isError: true });
    }
    expect(fn).not.toHaveBeenCalled();
  });
});
