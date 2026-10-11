/**
 * The one role editor keeps what the retired workspace editor did for
 * connectors: list the team's connectors, opt the role in or out of each
 * (saved as connectorRefs), add one from the MCP Registry (created on the
 * team, then opted in), and, for a workspace role, say whether a connector is
 * enabled for that workspace and check its health.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/roles/builder/edit' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/settings/roles/builder/edit',
  useSearchParams: () => new URLSearchParams(''),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TeamRoleEditor } = await import('./TeamRoleEditor');

// Illustrative fixtures only.
const role = {
  id: 'role-1', teamId: 'team-1', workspaceId: null as string | null, slug: 'builder', name: 'Builder',
  description: null, content: 'You build.', model: 'inherit', defaultBackend: null,
  allowedTools: ['Read'], canDelegateTo: [], background: false, maxTurns: null, color: '#0C72CB',
  mcpServers: [], requiredEnvVars: {}, isRole: true, repoUrl: null,
  connectorRefs: ['c-1'],
};
const connectors = [
  { id: 'c-1', name: 'github', url: 'https://example.test/mcp', authMode: 'oauth', status: 'connected' },
  { id: 'c-2', name: 'linear', url: 'https://example.test/linear', authMode: 'header', status: 'expired' },
];

type Call = [string, RequestInit | undefined];
let calls: Call[];
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push([u, init]);
    if (init?.method === 'PATCH') {
      return new Response(JSON.stringify({ skill: { ...role, ...JSON.parse(String(init.body)) } }), { status: 200 });
    }
    if (init?.method === 'POST' && u === '/api/connectors') {
      return new Response(JSON.stringify({ connector: { id: 'c-3', name: 'postgres', url: null, authMode: 'none', status: 'not_connected' } }), { status: 200 });
    }
    if (u.startsWith('/api/connectors')) return new Response(JSON.stringify({ connectors }), { status: 200 });
    if (u === '/api/workspaces/ws-1/connectors') return new Response(JSON.stringify({ connectors: [{ id: 'c-1' }] }), { status: 200 });
    if (u.startsWith('/api/workspaces/ws-1/connector-health')) {
      return new Response(JSON.stringify({ connectors: [{ connectorId: 'c-1', status: 'ok' }] }), { status: 200 });
    }
    if (u.startsWith('/api/mcp/registry')) {
      return new Response(JSON.stringify({ servers: [{ server: { name: 'io.example/postgres', description: 'Postgres', version: '1.0.0', packages: [{ registryType: 'npm', identifier: '@example/pg', transport: ['stdio'], environmentVariables: [{ name: 'PG_URL', description: 'url' }] }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const box = (name: string) => container.querySelector<HTMLInputElement>(`input[type="checkbox"][data-connector="${name}"]`);
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
const patchBody = () => {
  const patch = calls.find(([, init]) => init?.method === 'PATCH');
  return patch ? JSON.parse(String(patch[1]!.body)) : null;
};

async function render(r: typeof role) {
  await act(async () => {
    root.render(<TeamRoleEditor role={r} overrides={[]} workspaces={[{ id: 'ws-1', name: 'Workspace 1' }]} delegateOptions={[]} />);
  });
  await flush();
}

describe('role connectors in the one role editor', () => {
  it('lists the team connectors with the role opted into its own', async () => {
    await render(role);
    expect(container.textContent).toContain('Connectors');
    expect(box('github')?.checked).toBe(true);
    expect(box('linear')?.checked).toBe(false);
  });

  it('saves a toggled connector as connectorRefs', async () => {
    await render(role);
    await act(async () => { box('linear')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="header-save"]')!.click(); });
    await flush();
    expect(patchBody()?.connectorRefs?.sort()).toEqual(['c-1', 'c-2']);
  });

  it('adds a registry server to the team and opts the role into it', async () => {
    await render(role);
    await act(async () => { button('Browse registry')!.click(); });
    const search = container.querySelector<HTMLInputElement>('input[placeholder^="Search the MCP Registry"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'postgres');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(r => setTimeout(r, 350)); });
    await act(async () => { button('Add')!.click(); });
    await flush();
    const post = calls.find(([u, init]) => u === '/api/connectors' && init?.method === 'POST');
    expect(JSON.parse(String(post![1]!.body))).toMatchObject({ name: 'postgres', transport: 'stdio', command: 'npx', envMapping: { PG_URL: 'PG_URL' }, reuseIfExists: true });
    expect(box('postgres')?.checked).toBe(true);
  });

  it('tells a workspace role which connectors that workspace has enabled, and checks health', async () => {
    await render({ ...role, workspaceId: 'ws-1' });
    expect(container.textContent).toContain('Not enabled for this workspace');
    await act(async () => { button('Check health')!.click(); });
    await flush();
    expect(calls.some(([u]) => u === '/api/workspaces/ws-1/connector-health?roleSlug=builder')).toBe(true);
    expect(container.textContent).toContain('Healthy');
  });

  it('offers no health check for a team role (health is per workspace)', async () => {
    await render(role);
    expect(button('Check health')).toBeUndefined();
  });
});

describe('turning a role on and off in the editor', () => {
  it('saves enabled: false when "Use for new tasks" is unticked', async () => {
    await render({ ...role, enabled: true } as typeof role);
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"][data-testid="role-enabled"]')!;
    expect(box.checked).toBe(true);
    await act(async () => { box.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="header-save"]')!.click(); });
    await flush();
    expect(patchBody()?.enabled).toBe(false);
  });

  it('says a turned-off role takes no new tasks', async () => {
    await render({ ...role, enabled: false } as typeof role);
    expect(container.querySelector<HTMLInputElement>('[data-testid="role-enabled"]')!.checked).toBe(false);
    expect(container.textContent).toContain('Turned off');
  });
});
