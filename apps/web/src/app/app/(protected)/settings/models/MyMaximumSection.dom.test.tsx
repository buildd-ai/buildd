/**
 * My maximum, on You › Keys: the member's own tier maximum. Reads the server's
 * read model, writes only /me, never works out the effective maximum itself.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/keys', width: 390, height: 844 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MyMaximumSection } = await import('./MyMaximumSection');

const eff = (layers: { source: string; tier: string }[]) => {
  const order = ['budget', 'standard', 'premium', 'premium-plus'];
  const low = [...layers].sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier))[0];
  return { max: low?.tier ?? null, binding: low ?? null, layers, identified: true, overCapAuto: 'downgrade', explanation: '' };
};

let team: Record<string, string>;
let self: Record<string, string>;
let puts: { url: string; body: unknown }[];
let putResponse: { status: number; body: unknown };
let reads: number;

beforeEach(() => {
  team = { all: 'premium' }; self = {};
  puts = []; reads = 0; putResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'PUT') {
      puts.push({ url: u, body: JSON.parse(String(init.body)) });
      return Response.json(putResponse.body, { status: putResponse.status });
    }
    reads++;
    const layers = [
      ...(team.all ? [{ source: 'team', tier: team.all }] : []),
      ...(self.all ? [{ source: 'member_self', tier: self.all }] : []),
    ];
    return Response.json({
      policy: { team, workspaces: {}, overCapAuto: 'downgrade' },
      me: { admin: {}, self },
      effective: { agent: eff(layers), chat: eff(layers) },
      canManage: false,
    });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<MyMaximumSection teamId="t1" />); });
  await flush(); await flush();
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function pick(triggerId: string, optionLabel: string) {
  await act(async () => { q(triggerId)!.click(); });
  return [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith(optionLabel)) as HTMLElement;
}

describe('MyMaximumSection', () => {
  it('is titled My maximum and offers the member their own select', async () => {
    await mount();
    expect(host.textContent).toContain('My maximum');
    expect(q('self-all')).not.toBeNull();
  });

  it('a member cannot pick above the team maximum: option disabled with the reason, no write', async () => {
    await mount();
    const opt = await pick('self-all', 'Premium-plus');
    expect(opt.getAttribute('aria-disabled')).toBe('true');
    expect(opt.textContent).toContain('Above');
    await act(async () => { opt.click(); });
    expect(puts).toHaveLength(0);
  });

  it('lowering their own maximum writes only /me and refetches the read model', async () => {
    await mount();
    const before = reads;
    const opt = await pick('self-all', 'Standard');
    await act(async () => { opt.click(); });
    await flush();
    expect(puts).toEqual([{ url: '/api/teams/t1/model-ceilings/me', body: { ceilings: { all: 'standard' } } }]);
    expect(reads).toBeGreaterThan(before);
  });

  it("shows the server's message when a write is refused", async () => {
    putResponse = { status: 400, body: { error: 'That tier is not allowed.' } };
    await mount();
    const opt = await pick('self-all', 'Standard');
    await act(async () => { opt.click(); });
    await flush();
    expect(host.textContent).toContain('That tier is not allowed.');
  });
});
