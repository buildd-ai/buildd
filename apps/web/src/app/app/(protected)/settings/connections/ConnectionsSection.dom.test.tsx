/**
 * Settings → Connected apps, mounted (happy-dom): rows show the kind and the
 * meta line; opening one lists its workspaces by team; the picker turns a
 * selection into adds and removes; a person connection can be made an agent
 * and an agent one offers no way back; revoke asks first; legacy connections
 * get the one-connection hint; the empty state is plain text.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connections' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ConnectionsSection } = await import('./ConnectionsSection');
type Data = import('./ConnectionsSection').ConnectionsData;
type Summary = import('@/lib/mcp-grant-patch').ConnectionSummary;

const NOW = new Date('2026-10-09T12:00:00Z');
const teams = [
  { id: 't1', name: 'Platform', role: 'owner', workspaces: [{ id: 'w1', name: 'api' }, { id: 'w2', name: 'web' }, { id: 'w3', name: 'docs' }] },
  { id: 't2', name: 'Side', role: 'member', workspaces: [{ id: 'w4', name: 'blog' }] },
];
const person: Summary = {
  id: 'g-person', clientName: 'Laptop app', actsAs: 'person', access: 'read-write', createdAt: '2026-10-01T00:00:00Z',
  lastActiveAt: '2026-10-09T09:00:00Z', expiresAt: null, unreachableCount: 0,
  workspaces: [{ id: 'w1', name: 'api', teamId: 't1', teamName: 'Platform' }, { id: 'w4', name: 'blog', teamId: 't2', teamName: 'Side' }],
};
const agent: Summary = { ...person, id: 'g-agent', clientName: 'Hosted app', actsAs: 'agent', access: 'read', unreachableCount: 1, workspaces: [person.workspaces[0]] };

let calls: Array<{ kind: 'patch' | 'revoke'; id: string; body?: unknown }> = [];
let patchResult: (id: string, body: any) => any = (id, body) => ({ ok: true, connection: { ...(id === person.id ? person : agent), ...(body.actsAs ? { actsAs: body.actsAs } : {}), ...(body.access ? { access: body.access } : {}) } });
const api = {
  patch: async (id: string, body: unknown) => { calls.push({ kind: 'patch', id, body }); return patchResult(id, body); },
  revoke: async (id: string) => { calls.push({ kind: 'revoke', id }); return { ok: true as const }; },
};

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  calls = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(data: Partial<Data> = {}, open: string | null = null) {
  const initial: Data = { connections: [person, agent], legacy: [], teams, ...data };
  await act(async () => { root.render(createElement(ConnectionsSection, { initial, api, now: NOW, initiallyOpen: open })); });
}
const q = (id: string, scope: ParentNode = container) => scope.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const all = (id: string, scope: ParentNode = container) => [...scope.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
const click = async (el: Element | null) => {
  if (!el) throw new Error('missing element');
  await act(async () => { (el as HTMLElement).click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const button = (text: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null;

describe('ConnectionsSection', () => {
  it('lists each connection with its kind and one meta line', async () => {
    await mount();
    const rows = all('connection-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Laptop app');
    expect(rows[0].textContent).toContain('acts as you');
    expect(rows[0].textContent).toContain('2 workspaces · read and write · active 3 hours ago');
    expect(rows[1].textContent).toContain('agent for you');
  });

  it('opens to the workspaces grouped by team', async () => {
    await mount({}, person.id);
    const ws = q('connection-workspaces')!;
    expect(ws.textContent).toContain('Platform');
    expect(ws.textContent).toContain('Side');
    expect(all('connection-workspace').map((r) => r.textContent)).toEqual(['apiRemove', 'blogRemove']);
  });

  it('removes one workspace with a single PATCH', async () => {
    await mount({}, person.id);
    await click(container.querySelector('[aria-label="Remove blog"]'));
    expect(calls).toEqual([{ kind: 'patch', id: person.id, body: { removeWorkspaceIds: ['w4'] } }]);
  });

  it('will not remove the last workspace; that is a revoke', async () => {
    await mount({}, agent.id);
    expect((container.querySelector('[aria-label="Remove api"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('connection-row')!.parentElement!.textContent).toContain('One more workspace is out of reach');
  });

  it('the picker starts from what the connection reaches and saves the difference', async () => {
    await mount({}, person.id);
    await click(q('connection-change-workspaces'));
    const picker = q('workspace-picker')!;
    const boxes = () => all('picker-workspace', picker) as HTMLInputElement[];
    expect(boxes().filter((b) => b.checked).map((b) => b.value).sort()).toEqual(['w1', 'w4']);
    await click(boxes().find((b) => b.value === 'w2')!); // add web
    await click(boxes().find((b) => b.value === 'w4')!); // drop blog
    await click(q('picker-save', picker));
    expect(calls).toEqual([{ kind: 'patch', id: person.id, body: { addWorkspaceIds: ['w2'], removeWorkspaceIds: ['w4'] } }]);
    expect(q('workspace-picker')).toBeNull();
  });

  it('the picker reuses the consent reducer: select all in a team', async () => {
    await mount({}, agent.id);
    await click(q('connection-change-workspaces'));
    await click(container.querySelector('[aria-label="Select all in Platform"]'));
    expect(q('picker-count')!.textContent).toContain('3 of 4 chosen');
  });

  it('shows the server refusal and keeps the picker open', async () => {
    patchResult = () => ({ ok: false, error: 'One of the chosen workspaces is not available to you. Nothing was changed.' });
    await mount({}, agent.id);
    await click(q('connection-change-workspaces'));
    await click((all('picker-workspace') as HTMLInputElement[]).find((b) => b.value === 'w2')!);
    await click(q('picker-save'));
    expect(q('connection-error')!.textContent).toContain('Nothing was changed');
    expect(q('workspace-picker')).not.toBeNull();
    patchResult = (id, body) => ({ ok: true, connection: { ...(id === person.id ? person : agent), ...body } });
  });

  it('switches between read only and read and write', async () => {
    await mount({}, agent.id);
    await click(button('Read and write'));
    expect(calls).toEqual([{ kind: 'patch', id: agent.id, body: { access: 'read-write' } }]);
  });

  it('a person connection can be made an agent, after a confirm', async () => {
    await mount({}, person.id);
    await click(q('connection-make-agent'));
    expect(calls).toEqual([]);
    await click(q('connection-make-agent-confirm'));
    expect(calls).toEqual([{ kind: 'patch', id: person.id, body: { actsAs: 'agent' } }]);
    expect(q('connection-kind')!.textContent).toContain('Agent working for you');
  });

  it('an agent connection offers no way to act as you, only reconnecting', async () => {
    await mount({}, agent.id);
    const kind = q('connection-kind')!;
    expect(kind.querySelector('button')).toBeNull();
    expect(kind.textContent).toContain('connect the app again');
  });

  it('revoke asks first, then drops the row', async () => {
    await mount({}, agent.id);
    await click(q('connection-revoke'));
    expect(calls).toEqual([]);
    await click(q('connection-revoke-yes'));
    expect(calls).toEqual([{ kind: 'revoke', id: agent.id }]);
    expect(all('connection-row').length).toBe(1);
    expect(container.textContent).toContain('Hosted app is disconnected.');
  });

  it('legacy per-workspace connections get the one-connection hint', async () => {
    await mount({ legacy: [{ clientName: 'Old app', workspaceName: 'api', lastActiveAt: '2026-10-08T10:00:00Z' }] });
    const n = q('connections-legacy')!;
    expect(n.textContent).toContain('One older connection reaches a single workspace');
    expect(n.textContent).toContain('Old app');
    expect(n.textContent).toContain('buildd install --oauth');
  });

  it('empty: plain text, no frame', async () => {
    await mount({ connections: [] });
    const e = q('connections-empty')!;
    expect(e.tagName).toBe('P');
    expect(e.textContent).toContain('No apps are connected.');
  });
});
