import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 390, height: 844 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ChatTierPolicySection } = await import('./ChatTierPolicySection');

let team: Record<string, unknown>;
let chatMax: string | null;
let patches: unknown[];
beforeEach(() => {
  team = { chatDefaultTier: 'premium', chatCapNewSessionTier: false };
  chatMax = null; patches = [];
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { patches.push(JSON.parse(String(init.body))); return Response.json({}); }
    if (String(url).endsWith('/model-ceilings')) return Response.json({ effective: { chat: { max: chatMax } } });
    return Response.json({ team });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(isAdmin = true) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<ChatTierPolicySection teamId="t1" isAdmin={isAdmin} />); });
  await flush(); await flush();
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('ChatTierPolicySection', () => {
  it('is a default, not a cap: no cap switch, no "Cap at this tier"', async () => {
    await mount();
    expect(host.textContent).toContain('Starting tier for new chats');
    expect(host.textContent).not.toContain('Cap at this tier');
    expect(q('legacy-reset-notice')).toBeNull();
  });

  it('explains a leftover reset once and turning it off writes only that flag', async () => {
    team.chatCapNewSessionTier = true;
    await mount();
    expect(q('legacy-reset-notice')!.textContent).toContain('not a limit');
    await act(async () => { q('legacy-reset-off')!.click(); });
    await flush();
    expect(patches).toEqual([{ chatCapNewSessionTier: false }]);
  });

  it('warns when the starting tier is above the Chat maximum and disables it as an option', async () => {
    chatMax = 'standard';
    await mount();
    expect(q('starting-tier-blocked')!.textContent).toContain('new chats start at standard');
    await act(async () => { q('chat-default-tier')!.click(); });
    const opt = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith('premium')) as HTMLElement;
    expect(opt.getAttribute('aria-disabled')).toBe('true');
  });

  it('non-admins cannot edit or resolve the reset', async () => {
    team.chatCapNewSessionTier = true;
    await mount(false);
    expect(q('legacy-reset-off')).toBeNull();
  });
});
