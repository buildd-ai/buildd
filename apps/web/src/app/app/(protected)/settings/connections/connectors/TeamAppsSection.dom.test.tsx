/**
 * Settings → Connected apps → Team apps in a browser (happy-dom): one row per
 * app with its state and one step. An admin connects, reconnects and manages
 * an app in its details; a member reads the same rows and can only request an
 * app the team has not set up. A provider that won't let buildd connect reads
 * "Not available", with no Connect and nothing about why.
 * Runs in its own process (scripts/run-unit-tests.ts), so the globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connections' });

import { describe, expect, it } from 'bun:test';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TeamAppsSection } = await import('./TeamAppsSection');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (slug: string, over: Record<string, unknown> = {}) => ({
  slug, name: slug[0].toUpperCase() + slug.slice(1), url: `https://mcp.${slug}.example/mcp`, authMode: 'oauth',
  description: `${slug} desc`, category: 'other', iconUrl: '', id: null, source: 'builtin', policy: 'available', ...over,
});
const conn = (id: string, slug: string, over: Record<string, unknown> = {}) => ({
  id, name: slug, url: `https://mcp.${slug}.example/mcp`, authMode: 'oauth', status: 'connected', ...over,
});
const WS = [{ id: 'ws-1', name: 'web' }, { id: 'ws-2', name: 'api' }];

const CATALOG = [
  entry('axiom'),
  entry('sentry'),
  entry('linear'),
  entry('neon', { policy: 'blocked' }),
  entry('vercel', { unavailable: true }),
];
const CONNECTORS = [
  conn('c-axiom', 'axiom'),
  conn('c-sentry', 'sentry', { status: 'expired' }),
];

type Call = { url: string; method: string; body?: any };
function stubFetch(o: { canManage: boolean; entries?: unknown[]; connectors?: unknown[]; on?: (u: string, method: string, body: any) => Response | null }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });
    const custom = o.on?.(u, method, body);
    if (custom) return custom;
    if (u === '/api/connectors/catalog') return new Response(JSON.stringify({ canManage: o.canManage, entries: o.entries ?? CATALOG }));
    if (u.startsWith('/api/connectors?')) return new Response(JSON.stringify({ connectors: o.connectors ?? CONNECTORS }));
    if (u === '/api/workspaces/ws-1/connectors' && method === 'GET') return new Response(JSON.stringify({ connectors: [{ id: 'c-axiom' }] }));
    if (u.startsWith('/api/workspaces/') && method === 'GET') return new Response(JSON.stringify({ connectors: [] }));
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  return calls;
}

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
async function mount(props: Record<string, unknown> = {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(<TeamAppsSection teamId="team-1" workspaces={WS} {...props} />); });
  await flush(); await flush();
  return { el, unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
}
const q = (el: ParentNode, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (n: Element | null) => { await act(async () => { (n as HTMLElement).click(); }); await flush(); await flush(); };

describe('TeamAppsSection', () => {
  it('admin: each app shows its state and its one step', async () => {
    stubFetch({ canManage: true });
    const { el, unmount } = await mount();
    expect(q(el, 'team-app-state-axiom')!.textContent).toBe('Connected');
    expect(q(el, 'team-app-step-sentry')!.textContent).toBe('Reconnect');
    expect(q(el, 'team-app-sentry')!.textContent).toContain('Sign-in expired');
    expect(q(el, 'team-app-step-linear')!.textContent).toBe('Connect');
    expect(q(el, 'team-app-state-neon')!.textContent).toBe('Blocked by your team');
    expect(q(el, 'team-apps-add')).not.toBeNull();
    // No row-level policy switch on the list.
    expect(el.querySelector('[role="radiogroup"]')).toBeNull();
    await unmount();
  });

  it('an unavailable provider: Not available, no Connect, no details, and nothing about provider review', async () => {
    stubFetch({ canManage: true });
    const { el, unmount } = await mount();
    const row = q(el, 'team-app-vercel')!;
    expect(q(el, 'team-app-state-vercel')!.textContent).toBe('Not available');
    expect(q(el, 'team-app-step-vercel')).toBeNull();
    expect(q(el, 'team-app-toggle-vercel')).toBeNull();
    expect(row.querySelector('a')).toBeNull();
    expect(el.textContent).not.toMatch(/review|approv|coming soon/i);
    // Listed last.
    const rows = [...el.querySelectorAll('[data-testid^="team-app-"][data-state]')].map(n => n.getAttribute('data-testid'));
    expect(rows[rows.length - 1]).toBe('team-app-vercel');
    await unmount();
  });

  it('admin Connect installs the app, then starts the sign-in', async () => {
    let assigned = '';
    const loc = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...loc, set href(v: string) { assigned = v; }, get href() { return assigned; } } });
    const calls = stubFetch({
      canManage: true,
      on: (u, m) => (u === '/api/connectors' && m === 'POST' ? new Response(JSON.stringify({ connector: { id: 'c-linear' } }), { status: 201 })
        : u === '/api/connectors/c-linear/connect' ? new Response(JSON.stringify({ authorizationUrl: 'https://linear.example/authorize' })) : null),
    });
    const { el, unmount } = await mount();
    await click(q(el, 'team-app-step-linear'));
    expect(calls.find(c => c.url === '/api/connectors' && c.method === 'POST')!.body).toEqual({ name: 'Linear', url: 'https://mcp.linear.example/mcp' });
    expect(assigned).toBe('https://linear.example/authorize');
    Object.defineProperty(window, 'location', { configurable: true, value: loc });
    await unmount();
  });

  it('a refused install shows the server’s message, never a raw code', async () => {
    stubFetch({
      canManage: true,
      on: (u, m) => (u === '/api/connectors' && m === 'POST' ? new Response(JSON.stringify({ error: 'needs_approved_client', message: "Linear isn't available to connect." }), { status: 422 }) : null),
    });
    const { el, unmount } = await mount();
    await click(q(el, 'team-app-step-linear'));
    expect(q(el, 'team-apps-message')!.textContent).toBe("Linear isn't available to connect.");
    await unmount();
  });

  it('admin details: workspaces as checkboxes, the team setting as one select, sharing and remove', async () => {
    const calls = stubFetch({ canManage: true });
    const { el, unmount } = await mount();
    await click(q(el, 'team-app-toggle-axiom'));
    const details = q(el, 'team-app-details-axiom')!;
    expect(details.textContent).toContain('1 of 2 workspaces');
    const ws2 = q(el, 'team-app-ws-axiom-ws-2') as HTMLInputElement;
    expect((q(el, 'team-app-ws-axiom-ws-1') as HTMLInputElement).checked).toBe(true);
    expect(ws2.checked).toBe(false);
    await click(ws2);
    expect(calls.find(c => c.url === '/api/workspaces/ws-2/connectors' && c.method === 'PATCH')!.body).toEqual({ connectorId: 'c-axiom', enabled: true });
    expect(details.textContent).toContain('All workspaces');
    expect(q(el, 'team-app-policy-axiom')).not.toBeNull();
    expect(details.textContent).toContain('Share with a team');
    expect(details.textContent).toContain('Remove');
    await unmount();
  });

  it('member: read-only rows, Request for an app not set up, no admin controls', async () => {
    // A member's catalog never carries blocked or unavailable entries (the API filters them).
    const calls = stubFetch({ canManage: false, entries: CATALOG.filter(e => e.policy !== 'blocked' && !e.unavailable) });
    const { el, unmount } = await mount();
    expect(q(el, 'team-apps-member-note')).not.toBeNull();
    expect(q(el, 'team-apps-add')).toBeNull();
    expect(q(el, 'team-app-step-sentry')).toBeNull();
    expect(q(el, 'team-app-state-sentry')!.textContent).toBe('Sign-in expired');
    expect(q(el, 'team-app-vercel')).toBeNull();
    await click(q(el, 'team-app-toggle-axiom'));
    const details = q(el, 'team-app-details-axiom')!;
    expect(details.querySelector('input[type="checkbox"]')).toBeNull();
    expect(q(el, 'team-app-policy-axiom')).toBeNull();
    expect(details.querySelector('button')).toBeNull();
    expect(details.textContent).toContain('web');

    expect(q(el, 'team-app-step-linear')!.textContent).toBe('Request');
    await click(q(el, 'team-app-step-linear'));
    expect(calls.find(c => c.url === '/api/connectors/catalog/request')!.body).toEqual({ slug: 'linear' });
    expect(q(el, 'team-apps-message')!.textContent).toContain('Asked your team’s admins for Linear.');
    expect(q(el, 'team-app-state-linear')!.textContent).toBe('Requested');
    await unmount();
  });

  it('an app shared in by another team names that team once and offers no Reconnect', async () => {
    stubFetch({ canManage: true, connectors: [conn('c-axiom', 'axiom', { shared: true, ownerTeamName: 'Platform', status: 'expired' })] });
    const { el, unmount } = await mount();
    expect(q(el, 'team-app-step-axiom')).toBeNull();
    expect(q(el, 'team-app-axiom')!.textContent!.match(/Platform/g)).toHaveLength(1);
    await unmount();
  });

  it('OAuth callback errors read in plain words; an unknown code is a plain retry', async () => {
    stubFetch({ canManage: true });
    const a = await mount({ errorMsg: 'forbidden' });
    expect(q(a.el, 'team-apps-message')!.textContent).toBe('Only a team admin can connect a team app.');
    await a.unmount();
    const b = await mount({ errorMsg: 'invalid_redirect_uri' });
    expect(q(b.el, 'team-apps-message')!.textContent).toBe('The sign-in didn’t finish. Try Connect again.');
    await b.unmount();
  });
});
