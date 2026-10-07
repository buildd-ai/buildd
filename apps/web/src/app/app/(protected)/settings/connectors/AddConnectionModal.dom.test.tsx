/**
 * Add connection modal in a browser (happy-dom): the catalog step, the
 * one-click preset path, and the custom-URL path surfacing the server's reason
 * instead of a bare "Failed to create connector".
 * Runs in its own process (scripts/run-unit-tests.ts), so the globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connectors' });

import { describe, expect, it } from 'bun:test';
// react-dom probes event support when it loads, so it must load after happy-dom.
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { default: AddConnectionModal } = await import('./AddConnectionModal');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { url: string; body?: unknown };
function stubFetch(onCreate: (body: Record<string, unknown>) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    if (String(url) === '/api/connectors' && init?.method === 'POST') return onCreate(body);
    return new Response(JSON.stringify({ workspaces: [], teams: [] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

async function mount(props: Partial<Parameters<typeof AddConnectionModal>[0]> = {}) {
  const added: unknown[] = [];
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(<AddConnectionModal onClose={() => {}} onAdded={(c) => added.push(c)} {...props} />);
  });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return { el, added, unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
const click = async (b: Element | null) => { await act(async () => { (b as HTMLElement).click(); }); };
async function type(input: HTMLInputElement, value: string) {
  let proto = Object.getPrototypeOf(input);
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'value')) proto = Object.getPrototypeOf(proto);
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

describe('AddConnectionModal catalog', () => {
  it('opens on the catalog with the starter connectors and a custom option', async () => {
    stubFetch(() => new Response('{}'));
    const { el, unmount } = await mount();
    for (const slug of ['vercel', 'neon', 'axiom', 'custom']) expect(q(el, `connector-catalog-${slug}`)).not.toBeNull();
    await unmount();
  });

  it('marks catalog entries the team already has as Added and disables them', async () => {
    stubFetch(() => new Response('{}'));
    const { el, unmount } = await mount({ existingUrls: ['https://mcp.vercel.com/'] });
    expect(q(el, 'connector-catalog-vercel')!.disabled).toBe(true);
    expect(q(el, 'connector-catalog-vercel')!.textContent).toContain('Added');
    expect(q(el, 'connector-catalog-neon')!.disabled).toBe(false);
    await unmount();
  });

  it('a preset posts its catalog url and hands an oauth connector straight to the parent', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({
      connector: { id: 'c1', name: 'Neon', url: 'https://mcp.neon.tech/mcp', authMode: 'oauth', discoveredMetadata: { authMode: 'oauth' } },
    }), { status: 201 }));
    const { el, added, unmount } = await mount();
    await click(q(el, 'connector-catalog-neon'));
    expect(el.textContent).toContain('Add Neon');
    await click(el.querySelector('button[type="submit"]'));
    await flush();
    const create = calls.find(c => c.url === '/api/connectors');
    expect(create?.body).toMatchObject({ name: 'Neon', url: 'https://mcp.neon.tech/mcp' });
    expect(added).toEqual([expect.objectContaining({ id: 'c1', authMode: 'oauth' })]);
    await unmount();
  });

  it('custom url shows the server message on failure', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'invalid_url', message: 'URL must start with https:// (or http://).' }), { status: 400 }));
    const { el, unmount } = await mount();
    await click(q(el, 'connector-catalog-custom'));
    const [nameInput, urlInput] = Array.from(el.querySelectorAll('input')) as HTMLInputElement[];
    await type(nameInput, 'Axiom');
    await type(urlInput, 'ttps://mcp.axiom.co/mcp');
    await act(async () => { el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(el.textContent).toContain('URL must start with https://');
    await unmount();
  });
});
