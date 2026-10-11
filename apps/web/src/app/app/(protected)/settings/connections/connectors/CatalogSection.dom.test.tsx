/**
 * Settings → MCP connectors → Catalog in a browser (happy-dom): admins set a
 * per-entry policy and add team entries; members read what is available and
 * change nothing; each provider shows its real state for the team.
 * Runs in its own process (scripts/run-unit-tests.ts), so the globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connections' });

import { describe, expect, it } from 'bun:test';

// react-dom probes event support when it loads, so it must load after happy-dom.
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: CatalogSection } = await import('./CatalogSection');
const { describeControls } = await import('../../_lib/form-controls');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (slug: string, over: Record<string, unknown> = {}) => ({
  slug, name: slug[0].toUpperCase() + slug.slice(1), url: `https://mcp.${slug}.example/mcp`, authMode: 'oauth',
  description: `${slug} desc`, category: 'other', iconUrl: '', id: null, source: 'builtin', policy: 'available', ...over,
});

type Call = { url: string; method: string; body?: any };
function stubFetch(routes: { catalog: unknown; connectors?: unknown[]; policy?: () => Response; post?: () => Response; install?: () => Response; connect?: () => Response }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), method, body });
    if (url === '/api/connectors/catalog/policy') return routes.policy?.() ?? new Response(JSON.stringify({ ok: true }));
    if (url === '/api/connectors/catalog' && method === 'POST') return routes.post?.() ?? new Response(JSON.stringify({ entry: {} }), { status: 201 });
    if (url === '/api/connectors' && method === 'POST') return routes.install?.() ?? new Response(JSON.stringify({ connector: { id: 'new-1' } }), { status: 201 });
    if (String(url).endsWith('/connect')) return routes.connect?.() ?? new Response(JSON.stringify({ error: 'needs_approved_client', message: 'The provider has not approved buildd as a client.' }), { status: 422 });
    if (String(url).startsWith('/api/connectors') && !String(url).startsWith('/api/connectors/catalog')) return new Response(JSON.stringify({ connectors: routes.connectors ?? [] }));
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
  it('shows a member what is available, read-only: no policy, install or connect controls', async () => {
    // The API never sends a member a blocked entry; the page shows what it gets.
    stubFetch({ catalog: { canManage: false, entries: [entry('axiom', { policy: 'preinstalled' }), entry('neon')] } });
    const { el, unmount } = await mount();
    expect(q(el, 'catalog-member-note')).not.toBeNull();
    expect(q(el, 'catalog-entry-axiom')!.textContent).toContain('In every workspace');
    expect(q(el, 'catalog-state-neon')!.getAttribute('data-state')).toBe('not_installed');
    expect(q(el, 'catalog-add-toggle')).toBeNull();
    expect(q(el, 'catalog-step-neon')).toBeNull();
    expect(el.querySelector('[role="radiogroup"]')).toBeNull();
    expect(describeControls(el).filter(c => !/details/i.test(JSON.stringify(c)))).toEqual([]);
    await unmount();
  });

  it('shows each provider\'s real state: connected, expired with Reconnect, not installed with Install', async () => {
    stubFetch({
      catalog: { canManage: true, entries: [entry('axiom'), entry('sentry'), entry('neon')] },
      connectors: [
        { id: 'c-ax', url: 'https://mcp.axiom.example/mcp', authMode: 'oauth', status: 'connected' },
        { id: 'c-se', url: 'https://mcp.sentry.example/sse', authMode: 'oauth', status: 'expired' },
      ],
    });
    const { el, unmount } = await mount();
    expect(q(el, 'catalog-state-axiom')!.getAttribute('data-state')).toBe('connected');
    expect(q(el, 'catalog-step-axiom')).toBeNull();
    expect(q(el, 'catalog-state-sentry')!.getAttribute('data-state')).toBe('reconnect');
    expect(q(el, 'catalog-step-sentry')!.textContent).toBe('Reconnect');
    expect(q(el, 'catalog-step-neon')!.textContent).toBe('Install');
    await unmount();
  });

  it('a provider that has not approved buildd offers no Connect, only its review link', async () => {
    stubFetch({ catalog: { canManage: true, entries: [entry('vercel', { clientSupport: { status: 'needs_approved_client', detail: 'Vercel only lets reviewed clients sign in.', actionLabel: 'Vercel client review', actionUrl: 'https://vercel.example/review' } })] } });
    const { el, unmount } = await mount();
    expect(q(el, 'catalog-state-vercel')!.getAttribute('data-state')).toBe('needs_client_approval');
    expect(q(el, 'catalog-state-vercel')!.textContent).toBe('Client approval needed');
    expect(q(el, 'catalog-step-vercel')).toBeNull();
    expect(q(el, 'connector-client-support')!.textContent).toContain('Vercel client review');
    await unmount();
  });

  it('install shows the provider\'s own refusal instead of pretending to connect', async () => {
    const calls = stubFetch({ catalog: { canManage: true, entries: [entry('neon')] } });
    const { el, unmount } = await mount();
    await click(q(el, 'catalog-step-neon'));
    expect(calls.some(c => c.url === '/api/connectors' && c.method === 'POST' && c.body.url === 'https://mcp.neon.example/mcp')).toBe(true);
    expect(calls.some(c => c.url === '/api/connectors/new-1/connect')).toBe(true);
    expect(q(el, 'catalog-message')!.textContent).toContain('has not approved buildd');
    await unmount();
  });

  it('a blocked entry reads Blocked and offers no install, even to an admin', async () => {
    stubFetch({ catalog: { canManage: true, entries: [entry('axiom', { policy: 'blocked' })] } });
    const { el, unmount } = await mount();
    expect(q(el, 'catalog-state-axiom')!.textContent).toBe('Blocked');
    expect(q(el, 'catalog-step-axiom')).toBeNull();
    await unmount();
  });

  it('lists entries with their current policy selected and source label', async () => {
    stubFetch({ catalog: { canManage: true, entries: [entry('vercel', { policy: 'preinstalled' }), entry('internal', { source: 'team', id: 'r1' })] } });
    const { el, unmount } = await mount();
    expect(q(el, 'catalog-policy-vercel-preinstalled')!.getAttribute('aria-checked')).toBe('true');
    expect(q(el, 'catalog-policy-vercel-available')!.getAttribute('aria-checked')).toBe('false');
    // Preinstalled never reads as an agent grant.
    expect(q(el, 'catalog-entry-vercel')!.textContent).toContain('An agent gets it only if it is set up to use it');
    // Only team entries carry a source tag; built-in rows carry none.
    expect(q(el, 'catalog-entry-internal')!.textContent).toContain('Team');
    expect(q(el, 'catalog-entry-vercel')!.textContent).not.toContain('Built-in');
    // The URL is a detail, folded away until asked for.
    expect(q(el, 'catalog-entry-vercel')!.textContent).not.toContain('https://mcp.vercel.example/mcp');
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

  it('blocking says agents lose access but the saved connection is kept', async () => {
    stubFetch({
      catalog: { canManage: true, entries: [entry('axiom')] },
      policy: () => new Response(JSON.stringify({ slug: 'axiom', policy: 'blocked', connectorId: null, retainedConnectorIds: ['c1'] })),
    });
    const { el, unmount } = await mount();
    await click(q(el, 'catalog-policy-axiom-blocked'));
    expect(q(el, 'catalog-message')!.textContent).toContain('Agents can no longer use Axiom');
    expect(q(el, 'catalog-message')!.textContent).toContain('kept');
    expect(q(el, 'catalog-entry-axiom')!.textContent).toContain('even where it');
    await unmount();
  });

  it("shows a provider's client-approval requirement with where to fix it", async () => {
    stubFetch({ catalog: { canManage: true, entries: [entry('vercel', {
      clientSupport: { status: 'needs_approved_client', detail: 'Vercel has not approved buildd.', actionLabel: 'Vercel client review', actionUrl: 'https://vercel.com/docs/x' },
    })] } });
    const { el, unmount } = await mount();
    const note = q(el, 'connector-client-support')!;
    expect(note.textContent).toContain('Vercel has not approved buildd.');
    expect(note.querySelector('a')!.getAttribute('href')).toBe('https://vercel.com/docs/x');
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
