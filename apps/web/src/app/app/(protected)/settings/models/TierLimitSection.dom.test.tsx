/**
 * Maximum allowed: reads the server's read model, writes through the ceilings
 * API, never works out the effective maximum itself.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 390, height: 844 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TierLimitSection } = await import('./TierLimitSection');

type Eff = { max: string | null; binding: unknown; layers: { source: string; tier: string }[]; identified: boolean; overCapAuto: string; explanation: string };
const eff = (layers: { source: string; tier: string }[]): Eff => {
  const order = ['budget', 'standard', 'premium', 'premium-plus'];
  const low = [...layers].sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier))[0];
  return { max: low?.tier ?? null, binding: low ?? null, layers, identified: true, overCapAuto: 'downgrade', explanation: '' };
};

let state: { canManage: boolean; team: Record<string, string>; self: Record<string, string> };
let puts: { url: string; body: unknown }[];
let putResponse: { status: number; body: unknown };
let reads: number;

beforeEach(() => {
  state = { canManage: true, team: { all: 'premium' }, self: {} };
  puts = []; reads = 0; putResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/model-ceilings') && (!init || !init.method)) {
      reads++;
      const layers = [
        ...(state.team.all ? [{ source: 'team', tier: state.team.all }] : []),
        ...(state.self.all ? [{ source: 'member_self', tier: state.self.all }] : []),
      ];
      return Response.json({
        policy: { team: state.team, workspaces: {}, overCapAuto: 'downgrade' },
        me: { admin: {}, self: state.self },
        effective: { agent: eff(layers), chat: eff(layers) },
        canManage: state.canManage,
        ...(state.canManage ? { members: {} } : {}),
      });
    }
    if (init?.method === 'PUT') {
      puts.push({ url: u, body: JSON.parse(String(init.body)) });
      return Response.json(putResponse.body, { status: putResponse.status });
    }
    if (u.includes('/members')) return Response.json({ members: [{ userId: 'u2', name: 'Sam', email: null }] });
    if (u.includes('/api/workspaces')) return Response.json({ workspaces: [{ id: 'w1', name: 'api' }] });
    return Response.json({});
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(isAdmin: boolean) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<TierLimitSection teamId="t1" isAdmin={isAdmin} />); });
  await flush(); await flush();
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = () => host.textContent ?? '';
async function pick(triggerId: string, optionLabel: string) {
  await act(async () => { q(triggerId)!.click(); });
  const opt = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith(optionLabel)) as HTMLElement;
  return opt;
}

describe('TierLimitSection', () => {
  it('shows the server effective maximum with its source', async () => {
    await mount(true);
    expect(q('effective-agent')!.textContent).toContain('up to Premium');
    expect(q('effective-agent')!.textContent).toContain('set by the team');
  });

  it('shows team premium + my standard → standard, lowest wins', async () => {
    state.self = { all: 'standard' };
    await mount(false);
    expect(q('effective-chat')!.textContent).toContain('up to Standard');
    expect(q('effective-chat')!.textContent).toContain('the team Premium · you Standard');
  });

  it('says there is no restriction when nothing is set', async () => {
    state.team = {};
    await mount(false);
    expect(text()).toContain('No extra restriction');
  });

  it('a member cannot pick above the team maximum: option disabled with the reason, no write', async () => {
    await mount(false);
    const opt = await pick('self-all', 'Premium-plus');
    expect(opt.getAttribute('aria-disabled')).toBe('true');
    expect(opt.textContent).toContain('Above');
    await act(async () => { opt.click(); });
    expect(puts).toHaveLength(0);
  });

  it('a member lowering their own maximum writes only /me', async () => {
    await mount(false);
    const opt = await pick('self-all', 'Standard');
    await act(async () => { opt.click(); });
    await flush();
    expect(puts).toEqual([{ url: '/api/teams/t1/model-ceilings/me', body: { ceilings: { all: 'standard' } } }]);
  });

  it('non-admins get no team, workspace or member controls', async () => {
    state.canManage = false;
    await mount(false);
    expect(q('team-limit')).toBeNull();
    expect(q('workspace-limits')).toBeNull();
    expect(q('member-limits')).toBeNull();
    expect(q('team-limit-readonly')).not.toBeNull();
  });

  it('an admin sets the team maximum; the read model is refetched after', async () => {
    await mount(true);
    const before = reads;
    const opt = await pick('team-all', 'Standard');
    await act(async () => { opt.click(); });
    await flush();
    expect(puts[0]).toEqual({ url: '/api/teams/t1/model-ceilings', body: { team: { all: 'standard' } } });
    expect(reads).toBeGreaterThan(before);
  });

  it('shows the server error when a write is refused, and keeps the read model', async () => {
    putResponse = { status: 403, body: { error: 'Only a team admin can change team or workspace tier maximums.' } };
    await mount(true);
    const opt = await pick('team-all', 'Standard');
    await act(async () => { opt.click(); });
    await flush();
    expect(text()).toContain('Only a team admin can change');
    expect(q('team-all')!.textContent).toContain('Premium');
  });

  it('keeps Coding and Chat separate maximums behind Advanced, preserving the other keys', async () => {
    state.team = { all: 'premium' };
    await mount(true);
    expect(q('team-agent')).toBeNull();
    await act(async () => { q('team-advanced')!.click(); });
    const opt = await pick('team-chat', 'Standard');
    await act(async () => { opt.click(); });
    await flush();
    expect(puts[0].body).toEqual({ team: { all: 'premium', chat: 'standard' } });
  });

  it('lists workspace and member overrides for admins', async () => {
    await mount(true);
    expect(q('workspace-limits')!.textContent).toContain('api');
    expect(q('member-limits')!.textContent).toContain('Sam');
  });

  it('does not offer OAuth or subscription controls', async () => {
    await mount(true);
    expect(text().toLowerCase()).not.toContain('oauth');
    expect(text().toLowerCase()).not.toContain('subscription');
  });
});
