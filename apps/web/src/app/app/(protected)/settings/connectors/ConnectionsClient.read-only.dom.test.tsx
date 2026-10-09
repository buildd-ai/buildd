/**
 * Adding, connecting, sharing, disconnecting and deleting a team connector is
 * manage_connectors (the connector routes refuse anyone else, with the team's
 * overrides applied). A member sees the list and each status, and none of
 * those controls. The list is the page's active team, passed explicitly.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connectors' });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ConnectionsClient } = await import('./ConnectionsClient');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let urls: string[];
afterEach(() => { act(() => root.unmount()); host.remove(); });

const CONNECTORS = [
  { id: 'c1', name: 'Linear', url: 'https://mcp.example.com/linear', authMode: 'oauth', status: 'expired' },
  { id: 'c2', name: 'Docs', url: 'https://mcp.example.com/docs', authMode: 'header', status: 'not_connected' },
];

async function mount(canManage: boolean) {
  urls = [];
  globalThis.fetch = mock(async (url: string) => {
    urls.push(String(url));
    if (String(url).startsWith('/api/connectors')) return new Response(JSON.stringify({ connectors: CONNECTORS }), { status: 200 });
    return new Response(JSON.stringify({ teams: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<ConnectionsClient embedded teamId="t1" canManage={canManage} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const labels = () => [...host.querySelectorAll('button')].map((b) => b.textContent);

describe('ConnectionsClient: member vs admin', () => {
  it("lists the page's active team", async () => {
    await mount(false);
    expect(urls).toContain('/api/connectors?teamId=t1');
  });

  it('member: names and status, no controls', async () => {
    await mount(false);
    expect(host.textContent).toContain('Linear');
    expect(host.textContent).toContain('Expired');
    expect(labels()).toEqual([]);
    expect(host.querySelector('[data-testid="connectors-read-only"]')!.textContent).toBe('Admins can change this.');
  });

  it('admin: add, reconnect, set key, sharing and delete', async () => {
    await mount(true);
    for (const l of ['Add connector', 'Reconnect', 'Set key', 'Sharing', 'Delete']) expect(labels()).toContain(l);
    expect(host.querySelector('[data-testid="connectors-read-only"]')).toBeNull();
  });
});
