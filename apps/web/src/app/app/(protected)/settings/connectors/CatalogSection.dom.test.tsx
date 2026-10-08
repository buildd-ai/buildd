/**
 * Settings → MCP connectors → Catalog in a browser (happy-dom): admins set a
 * per-entry policy and add team entries; members see nothing.
 * Runs in its own process (scripts/run-unit-tests.ts), so the globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connectors' });

import { describe, expect, it } from 'bun:test';

// react-dom probes event support when it loads, so it must load after happy-dom.
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: CatalogSection } = await import('./CatalogSection');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (slug: string, over: Record<string, unknown> = {}) => ({
  slug, name: slug[0].toUpperCase() + slug.slice(1), url: `https://mcp.${slug}.example/mcp`, authMode: 'oauth',
  description: `${slug} desc`, category: 'other', iconUrl: '', id: null, source: 'builtin', policy: 'available', ...over,
});

type Call = { url: string; method: string; body?: any };
function stubFetch(routes: { catalog: unknown; policy?: () => Response; post?: () => Response }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), method, body });
    if (url === '/api/connectors/catalog/policy') return routes.policy?.() ?? new Response(JSON.stringify({ ok: true }));
    if (url === '/api/connectors/catalog' && method === 'POST') return routes.post?.() ?? new Response(JSON.stringify({ entry: {} }), { status: 201 });
    return new Response(JSON.stringify(routes.catalog));
  }) as typeof fetch;
  return calls;
}

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(<CatalogSection />); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return { el, unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
}
const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (n: Element | null) => { await act(async () => { (n as HTMLElement).click(); }); await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
async function type(input: HTMLInputElement, value: string) {
  let proto = Object.getPrototypeOf(input);
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'value')) proto = Object.getPrototypeOf(proto);
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

describe('CatalogSection', () => {
  it('renders nothing for a member', async () => {
    stubFetch({ catalog: { canManage: false, entries: [entry('vercel')] } });
    const { el, unmount } = await mount();
    expect(el.textContent).toBe('');
    await unmount();
  });

  it('lists entries with their current policy selected and source label', async () => {
    stubFetch({ catalog: { canManage: true, entries: [entry('vercel', { policy: 'preinstalled' }), entry('internal', { source: 'team', id: 'r1' })] } });
    const { el, unmount } = await mount();
    expect(q(el, 'catalog-policy-vercel-preinstalled')!.getAttribute('aria-checked')).toBe('true');
    expect(q(el, 'catalog-policy-vercel-available')!.getAttribute('aria-checked')).toBe('false');
    expect(q(el, 'catalog-entry-vercel')!.textContent).toContain('Roles still choose');
    expect(q(el, 'catalog-entry-internal')!.textContent).toContain('Your team');
    expect(q(el, 'catalog-remove-internal')).not.toBeNull();
    expect(q(el, 'catalog-remove-vercel')).toBeNull();
    await unmount();
  });

  it('clicking Preinstalled PUTs the policy and selects it', async () => {
    const calls = stubFetch({ catalog: { canManage: true, entries: [entry('neon')] } });
    const { el, unmount } = await mount();
    await click(q(el, 'catalog-policy-neon-preinstalled'));
    expect(calls.find(c => c.url === '/api/connectors/catalog/policy')).toMatchObject({ method: 'PUT', body: { slug: 'neon', policy: 'preinstalled' } });
    expect(q(el, 'catalog-policy-neon-preinstalled')!.getAttribute('aria-checked')).toBe('true');
    await unmount();
  });

  it('shows the server message when a policy change fails and keeps the old policy', async () => {
    stubFetch({
      catalog: { canManage: true, entries: [entry('neon')] },
      policy: () => new Response(JSON.stringify({ error: 'preinstall_failed', message: 'Could not set up Neon: discovery failed' }), { status: 422 }),
    });
    const { el, unmount } = await mount();
    await click(q(el, 'catalog-policy-neon-preinstalled'));
    expect(q(el, 'catalog-message')!.textContent).toContain('Could not set up Neon');
    expect(q(el, 'catalog-policy-neon-available')!.getAttribute('aria-checked')).toBe('true');
    await unmount();
  });

  it('adding a team entry POSTs the form body', async () => {
    const calls = stubFetch({ catalog: { canManage: true, entries: [] } });
    const { el, unmount } = await mount();
    await click(q(el, 'catalog-add-toggle'));
    const form = q(el, 'catalog-add-form')!;
    const [nameInput, urlInput] = Array.from(form.querySelectorAll('input')) as HTMLInputElement[];
    await type(nameInput, 'Internal tools');
    await type(urlInput, 'https://mcp.internal.example/mcp');
    await click(q(el, 'catalog-add-auth-header'));
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(calls.find(c => c.url === '/api/connectors/catalog' && c.method === 'POST')?.body).toMatchObject({
      name: 'Internal tools', url: 'https://mcp.internal.example/mcp', authMode: 'header', headerName: 'Authorization', category: 'other',
    });
    await unmount();
  });

  it('shows the server message when adding fails', async () => {
    stubFetch({
      catalog: { canManage: true, entries: [] },
      post: () => new Response(JSON.stringify({ error: 'discovery_failed', message: 'This server did not complete OAuth discovery' }), { status: 422 }),
    });
    const { el, unmount } = await mount();
    await click(q(el, 'catalog-add-toggle'));
    const form = q(el, 'catalog-add-form')!;
    const [nameInput, urlInput] = Array.from(form.querySelectorAll('input')) as HTMLInputElement[];
    await type(nameInput, 'X');
    await type(urlInput, 'https://mcp.x.example/mcp');
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(q(el, 'catalog-add-error')!.textContent).toContain('did not complete OAuth discovery');
    await unmount();
  });
});
