/**
 * ConnectorsSection (Settings > MCP connectors > Workspace access) in a browser
 * (happy-dom). Regression (UX review): with no connectors the section drew a
 * card that only said "Add a connector above, then choose its workspaces
 * here." The Add button right above already says that, so the empty section
 * goes. With more than one team it stays: its header holds the team switch.
 * Runs in its own process (scripts/run-unit-tests.ts), so the globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connectors' });

import { describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const { default: ConnectorsSection } = await import('./ConnectorsSection');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stubFetch(connectors: unknown[]) {
  globalThis.fetch = (async (url: string) => new Response(
    JSON.stringify(String(url).startsWith('/api/connectors') ? { connectors } : { connectors: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;
}

async function mount(props: Parameters<typeof ConnectorsSection>[0]) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(<ConnectorsSection {...props} />); });
  // Let load() settle.
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return { el, unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
}

const workspaces = [{ id: 'ws1', name: 'billing-web' }];

describe('Workspace access with no connectors', () => {
  it('renders nothing for a single team', async () => {
    stubFetch([]);
    const { el, unmount } = await mount({ workspaces, teams: [{ id: 't1', name: 'Harborline' }], currentTeamId: 't1' });
    expect(el.textContent).toBe('');
    await unmount();
  });

  it('keeps the section, and its team switch, when there are several teams', async () => {
    stubFetch([]);
    const { el, unmount } = await mount({ workspaces, teams: [{ id: 't1', name: 'A' }, { id: 't2', name: 'B' }], currentTeamId: 't1' });
    expect(el.textContent).toContain('Workspace access');
    await unmount();
  });

  it('lists a connector once there is one', async () => {
    stubFetch([{ id: 'c1', name: 'Linear', url: 'https://mcp.example.com', authMode: 'none', status: 'connected' }]);
    const { el, unmount } = await mount({ workspaces, teams: [{ id: 't1', name: 'Harborline' }], currentTeamId: 't1' });
    expect(el.textContent).toContain('Linear');
    await unmount();
  });
});

/**
 * Turning a connector on or off in a workspace is manage_connectors in that
 * workspace's team (the workspace connectors PATCH refuses anyone else). A
 * workspace outside those teams shows its state, read-only.
 */
describe('Workspace access: toggles only where the API allows them', () => {
  const connector = { id: 'c1', name: 'Linear', url: 'https://mcp.example.com', authMode: 'oauth', status: 'expired' };
  const two = [{ id: 'ws1', name: 'billing-web', teamId: 't1' }, { id: 'ws2', name: 'docs', teamId: 't2' }];
  const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')].map((b) => b.textContent);

  it('member everywhere: no toggles, no Reconnect, and says who can', async () => {
    stubFetch([connector]);
    const { el, unmount } = await mount({ workspaces: two, teams: [{ id: 't1', name: 'A' }], currentTeamId: 't1', manageableTeamIds: [] });
    expect(buttons(el)).toEqual([]);
    expect(el.textContent).toContain('billing-web');
    expect(el.querySelector('[data-testid="workspace-access-read-only"]')!.textContent).toBe('Admins can change this.');
    await unmount();
  });

  it('admin of one team: that workspace toggles, the other is read-only', async () => {
    stubFetch([connector]);
    const { el, unmount } = await mount({ workspaces: two, teams: [{ id: 't1', name: 'A' }], currentTeamId: 't1', manageableTeamIds: ['t1'] });
    expect(buttons(el)).toEqual(['Reconnect', 'billing-web']);
    expect(el.querySelector('[data-testid="workspace-access-read-only"]')).toBeNull();
    await unmount();
  });
});
