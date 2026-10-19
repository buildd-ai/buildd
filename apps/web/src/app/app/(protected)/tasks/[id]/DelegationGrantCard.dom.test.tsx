import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t', width: 1280, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const refresh = mock(() => {});
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: DelegationGrantCard } = await import('./DelegationGrantCard');

const TARGET = '00000000-0000-4000-8000-0000000000b2';
const grant = { grants: [{ workspaceId: TARGET, capabilities: ['analytics:read'] }] };
const needs = [{ workspaceId: TARGET, workspaceName: 'analytics-ws', capability: 'analytics:read' }];

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
afterEach(() => { act(() => root.unmount()); host.remove(); globalThis.fetch = realFetch; refresh.mockClear(); });

async function mount(canGrant = true) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<DelegationGrantCard taskId="t" needs={needs} grant={grant} canGrant={canGrant} />); });
}

describe('DelegationGrantCard', () => {
  it('names the uncovered read', async () => {
    await mount();
    expect(host.querySelector('[data-testid="delegation-grant-need"]')!.textContent).toBe('It will read analytics in analytics-ws');
  });

  it('one action PATCHes the covering delegation and refreshes the page', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 't', delegation: grant }), { status: 200 });
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => { (host.querySelector('[data-testid="delegation-grant-action"]') as HTMLButtonElement).click(); });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/tasks/t');
    expect(calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ delegation: grant });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the route refusal instead of refreshing', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'you do not reach it yourself' }), { status: 403 })) as unknown as typeof fetch;
    await mount();
    await act(async () => { (host.querySelector('[data-testid="delegation-grant-action"]') as HTMLButtonElement).click(); });
    expect(host.textContent).toContain('you do not reach it yourself');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a viewer who cannot grant is told who can, with no action', async () => {
    await mount(false);
    expect(host.querySelector('[data-testid="delegation-grant-action"]')).toBeNull();
    expect(host.textContent).toContain('Someone who reaches each of these workspaces can grant it here.');
  });
});
