/**
 * Provider routing on Settings › Models: a folded row with a status chip; the
 * Claude / Codex switches open underneath. Read-only without manage_team_settings.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 390, height: 844 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ProviderRoutingToggle } = await import('./ProviderRoutingToggle');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
let patches: unknown[] = [];

function installFetch(opts: { codex: boolean; enabled?: string[] | null }) {
  patches = [];
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (url === '/api/teams/t1' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      patches.push(body);
      return json({ team: body });
    }
    if (url === '/api/teams/t1') return json({ team: { enabledBackends: opts.enabled ?? null } });
    if (url.endsWith('/backends')) return json({ backends: [{ id: 'claude', available: true }, { id: 'codex', available: opts.codex }] });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

function Harness({ readOnly = false }: { readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  return <ProviderRoutingToggle teamId="t1" workspaceId="w1" open={open} onToggle={() => setOpen((v) => !v)} readOnly={readOnly} />;
}

async function mount(readOnly = false) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<Harness readOnly={readOnly} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const row = () => host.querySelector<HTMLElement>('[data-testid="routing-row"]')!;
const chips = () => [...row().querySelectorAll('span[data-tone]')].map((c) => c.textContent);
const buttons = () => [...row().querySelectorAll('button')];

describe('ProviderRoutingToggle', () => {
  it('folded, with Both on', async () => {
    installFetch({ codex: true });
    await mount();
    expect(row().getAttribute('data-open')).toBe('false');
    expect(chips()).toEqual(['Both on']);
  });

  it('names the provider that is off', async () => {
    installFetch({ codex: true, enabled: ['claude'] });
    await mount();
    expect(chips()).toEqual(['Codex off']);
  });

  it('turning Codex off saves the mask', async () => {
    installFetch({ codex: true });
    await mount();
    await act(async () => { row().querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    const codexOff = buttons().filter((b) => b.textContent === 'Turn off')[1];
    await act(async () => { codexOff.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(patches).toEqual([{ enabledBackends: ['claude'] }]);
    expect(row().textContent).toContain('Codex off. Jobs run on Claude.');
  });

  it('refuses to leave only a backend that cannot run', async () => {
    installFetch({ codex: false, enabled: ['codex', 'claude'] });
    await mount();
    await act(async () => { row().querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    const claudeOff = buttons().filter((b) => b.textContent === 'Turn off')[0];
    await act(async () => { claudeOff.click(); });
    expect(patches).toEqual([]);
    expect(row().textContent).toContain("Codex can't run yet.");
  });

  it('read-only: the chip stays, no button', async () => {
    installFetch({ codex: true });
    await mount(true);
    expect(row().getAttribute('data-readonly')).toBe('true');
    expect(chips()).toEqual(['Both on']);
    expect(buttons().length).toBe(0);
  });
});
