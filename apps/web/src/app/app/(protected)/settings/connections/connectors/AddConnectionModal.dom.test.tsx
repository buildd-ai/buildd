/**
 * Add connection modal in a browser (happy-dom): the catalog step, the
 * one-click preset path, and the custom-URL path surfacing the server's reason
 * instead of a bare "Failed to create connector".
 * Runs in its own process (scripts/run-unit-tests.ts), so the globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connections' });

import { describe, expect, it } from 'bun:test';
// react-dom probes event support when it loads, so it must load after happy-dom.
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const { default: AddConnectionModal } = await import('./AddConnectionModal');
const { CONNECTOR_CATALOG } = await import('@/lib/connector-catalog');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { url: string; body?: unknown };
function stubFetch(onCreate: (body: Record<string, unknown>) => Response, catalog?: () => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    if (String(url) === '/api/connectors' && init?.method === 'POST') return onCreate(body);
    if (String(url) === '/api/connectors/catalog') {
      return catalog ? catalog() : new Response(JSON.stringify({ canManage: true, entries: CONNECTOR_CATALOG.map(e => ({ ...e, id: null, source: 'builtin', policy: 'available' })) }));
    }
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

  it('renders the live catalog from the API and drops blocked entries', async () => {
    stubFetch(() => new Response('{}'), () => new Response(JSON.stringify({
      canManage: true,
      entries: [
        { slug: 'grafana', name: 'Grafana', url: 'https://mcp.grafana.example/mcp', authMode: 'oauth', description: 'team', category: 'observability', iconUrl: '', id: 'r1', source: 'team', policy: 'preinstalled' },
        { slug: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com', authMode: 'oauth', description: '', category: 'deploy', iconUrl: '', id: null, source: 'builtin', policy: 'blocked' },
      ],
    })));
    const { el, unmount } = await mount();
    expect(q(el, 'connector-catalog-grafana')).not.toBeNull();
    expect(q(el, 'connector-catalog-grafana')!.textContent).toContain('Preinstalled');
    expect(q(el, 'connector-catalog-vercel')).toBeNull();
    await unmount();
  });

  // Vercel only admits MCP clients it has reviewed (live-probed); the tile says
  // so up front instead of failing after a click with no explanation.
  it('flags the built-in Vercel entry as needing provider approval', async () => {
    stubFetch(() => new Response('{}'));
    const { el, unmount } = await mount();
    expect(q(el, 'connector-catalog-vercel')!.textContent).toContain('Needs approval');
    expect(q(el, 'connector-catalog-vercel-client-support')!.textContent).toContain('Vercel');
    expect(q(el, 'connector-catalog-axiom-client-support')).toBeNull();
    await unmount();
  });

  it('falls back to the built-ins when the catalog request fails', async () => {
    stubFetch(() => new Response('{}'), () => new Response('boom', { status: 500 }));
    const { el, unmount } = await mount();
    expect(q(el, 'connector-catalog-vercel')).not.toBeNull();
    expect(q(el, 'connector-catalog-neon')).not.toBeNull();
    await unmount();
  });

  it('a header-auth preset asks for the key and posts it with the header name', async () => {
    const calls = stubFetch(
      () => new Response(JSON.stringify({ connector: { id: 'c9', name: 'Stripe', url: 'https://mcp.stripe.com', authMode: 'header' } }), { status: 201 }),
      () => new Response(JSON.stringify({ canManage: true, entries: [
        { slug: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com', authMode: 'header', headerName: 'Authorization', description: '', category: 'other', iconUrl: '', id: 'p1', source: 'platform', policy: 'available' },
      ] })),
    );
    const { el, added, unmount } = await mount();
    await click(q(el, 'connector-catalog-stripe'));
    const key = el.querySelector('input[type="password"]') as HTMLInputElement;
    expect(key).not.toBeNull();
    await type(key, 'Bearer sk_test');
    await act(async () => { el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(calls.find(c => c.url === '/api/connectors')?.body).toMatchObject({ authMode: 'header', headerName: 'Authorization', headerValue: 'Bearer sk_test' });
    expect(added).toEqual([expect.objectContaining({ id: 'c9', status: 'connected' })]);
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

describe('AddConnectionModal "All my teams"', () => {
  // The server refuses a share into a team the actor only belongs to, so the
  // modal must count and target the teams the actor manages — not every team.
  function stubTeams() {
    const calls: Call[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body });
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/workspaces') return json({ workspaces: [{ id: 'w1', name: 'One' }] });
      if (url === '/api/teams') return json({ teams: [
        { id: 't1', name: 'Owned', role: 'owner', permissionOverrides: null },
        { id: 't2', name: 'Admined', role: 'admin', permissionOverrides: null },
        { id: 't3', name: 'Joined', role: 'member', permissionOverrides: null },
      ] });
      if (url === '/api/connectors' && init?.method === 'POST') {
        return json({ connector: { id: 'c1', teamId: 't1', name: 'Neon', url: 'https://mcp.neon.tech/mcp', authMode: 'oauth', discoveredMetadata: { authMode: 'oauth' } } }, 201);
      }
      return json({ entries: CONNECTOR_CATALOG.map(e => ({ ...e, id: null, source: 'builtin', policy: 'available' })) });
    }) as typeof fetch;
    return calls;
  }

  it('shares only into the other teams the actor manages', async () => {
    const calls = stubTeams();
    const { el, unmount } = await mount();
    await click(q(el, 'connector-catalog-neon'));
    const allTeams = Array.from(el.querySelectorAll('button')).find(b => b.textContent === 'All my teams');
    expect(allTeams).toBeDefined();
    await click(allTeams!);
    expect(el.textContent).toContain('every team you manage (2)');
    await click(el.querySelector('button[type="submit"]'));
    await flush();
    const shared = calls.filter(c => c.url === '/api/connectors/c1/shares').map(c => (c.body as { teamId: string }).teamId);
    expect(shared).toEqual(['t2']);
    await unmount();
  });
});
