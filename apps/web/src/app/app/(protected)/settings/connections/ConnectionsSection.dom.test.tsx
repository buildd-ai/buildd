/**
 * Settings → Connected apps, mounted (happy-dom): rows show the kind and a
 * meta line whose count does not read as fixed; opening one lists, per team,
 * how it reaches it (all current and future workspaces, or specific ones);
 * editing a team switches modes with a review before Save, and switching to
 * specific workspaces starts from what it reaches now; removing a single
 * workspace is only offered where it would really remove it; a stale save
 * shows the connection as it is now and keeps the edit; a person connection
 * can be made an agent and an agent one offers no way back; revoke asks
 * first; legacy connections get the one-connection hint; the empty state is
 * plain text.
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
const W = {
  w1: { id: 'w1', name: 'api', teamId: 't1', teamName: 'Platform' },
  w2: { id: 'w2', name: 'web', teamId: 't1', teamName: 'Platform' },
  w3: { id: 'w3', name: 'docs', teamId: 't1', teamName: 'Platform' },
  w4: { id: 'w4', name: 'blog', teamId: 't2', teamName: 'Side' },
};
const person: Summary = {
  id: 'g-person', clientName: 'Laptop app', actsAs: 'person', access: 'read-write', createdAt: '2026-10-01T00:00:00Z',
  lastActiveAt: '2026-10-09T09:00:00Z', expiresAt: null, unreachableCount: 0, unreachableTeamCount: 0, revision: 2,
  workspaces: [W.w1, W.w4],
  teams: [
    { teamId: 't1', teamName: 'Platform', mode: 'specific', workspaces: [W.w1] },
    { teamId: 't2', teamName: 'Side', mode: 'specific', workspaces: [W.w4] },
  ],
};
const agent: Summary = {
  ...person, id: 'g-agent', clientName: 'Hosted app', actsAs: 'agent', access: 'read', unreachableCount: 1, revision: 0,
  workspaces: [W.w1], teams: [{ teamId: 't1', teamName: 'Platform', mode: 'specific', workspaces: [W.w1] }],
};
const growing: Summary = {
  ...person, id: 'g-all', clientName: 'Hosted chat', actsAs: 'agent', revision: 7,
  workspaces: [W.w1, W.w3, W.w2], teams: [{ teamId: 't1', teamName: 'Platform', mode: 'all', workspaces: [W.w1, W.w3, W.w2] }],
};

let calls: Array<{ kind: 'patch' | 'revoke'; id: string; body?: unknown }> = [];
const byId = (id: string) => [person, agent, growing].find((c) => c.id === id)!;
const okResult = (id: string, body: any) => ({ ok: true, connection: { ...byId(id), ...(body.actsAs ? { actsAs: body.actsAs } : {}), ...(body.access ? { access: body.access } : {}), revision: byId(id).revision + 1 } });
let patchResult: (id: string, body: any) => any = okResult;
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
  patchResult = okResult;
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

  it('a connection with a team on all workspaces says its count grows', async () => {
    await mount({ connections: [growing] });
    expect(q('connection-row')!.textContent).toContain('3 workspaces now, plus new ones in 1 team');
  });

  it('opens to each team with its mode, and lists specific workspaces with Remove', async () => {
    await mount({}, person.id);
    const ws = q('connection-workspaces')!;
    expect(all('connection-team').map((t) => [t.dataset.team, t.dataset.mode])).toEqual([['t1', 'specific'], ['t2', 'specific']]);
    expect(ws.textContent).toContain('Platform');
    expect(ws.textContent).toContain('Specific workspaces · 1');
    expect(all('connection-workspace').map((r) => r.textContent)).toEqual(['apiRemove', 'blogRemove']);
  });

  it('a team on all workspaces offers no Remove that would not remove: it says to choose specific workspaces', async () => {
    await mount({ connections: [growing] }, growing.id);
    const team = q('connection-team')!;
    expect(team.dataset.mode).toBe('all');
    expect(q('connection-team-mode', team)!.textContent).toBe('All current and future workspaces · 3 now');
    expect(team.querySelector('[aria-label^="Remove"]')).toBeNull();
    expect(team.textContent).toContain('To leave one out, edit access and choose specific workspaces.');
  });

  it('removes one specific workspace with a single PATCH, sent with the revision on screen', async () => {
    await mount({}, person.id);
    await click(container.querySelector('[aria-label="Remove blog"]'));
    expect(calls).toEqual([{ kind: 'patch', id: person.id, body: { removeWorkspaceIds: ['w4'], ifRevision: 2 } }]);
    expect(q('connection-saved')!.textContent).toContain('uses the new access from its next request');
  });

  it('will not remove the last workspace; that is a revoke', async () => {
    await mount({}, agent.id);
    expect((container.querySelector('[aria-label="Remove api"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('connection-row')!.parentElement!.textContent).toContain('One more workspace is out of reach');
  });

  it('switching a team to all workspaces discloses the widening, with the permission it inherits, before Save', async () => {
    await mount({}, person.id);
    await click(container.querySelector('[aria-label="Edit access to Platform"]'));
    const editor = q('team-access-editor')!;
    await click(q('team-mode-all', editor));
    const review = q('team-access-review', editor)!;
    expect(review.textContent).toContain('This widens access');
    expect(review.textContent).toContain('Laptop app gets every workspace in Platform: 3 workspaces now, 2 more than today, and any created in or moved into Platform later.');
    expect(review.textContent).toContain('They get the same access: read and write, acting as you.');
    expect(calls).toEqual([]);
    expect(q('team-access-save', editor)!.textContent).toBe('Allow and save');
    await click(q('team-access-save', editor));
    expect(calls).toEqual([{ kind: 'patch', id: person.id, body: { teams: [{ teamId: 't1', mode: 'all' }], ifRevision: 2 } }]);
    expect(q('team-access-editor')).toBeNull();
  });

  it('switching from all to specific starts from what it reaches now, and saving freezes exactly that', async () => {
    await mount({ connections: [growing] }, growing.id);
    await click(container.querySelector('[aria-label="Edit access to Platform"]'));
    const editor = q('team-access-editor')!;
    await click(q('team-mode-specific', editor));
    const boxes = () => all('picker-workspace', editor) as HTMLInputElement[];
    expect(boxes().filter((b) => b.checked).map((b) => b.value).sort()).toEqual(['w1', 'w2', 'w3']);
    expect(q('team-access-review', editor)!.textContent).toContain('keeps exactly the 3 workspaces ticked in Platform. Workspaces created in or moved into Platform later are not included.');
    await click(q('team-access-save', editor));
    expect(calls).toEqual([{ kind: 'patch', id: growing.id, body: { teams: [{ teamId: 't1', mode: 'specific', workspaceIds: ['w1', 'w3', 'w2'] }], ifRevision: 7 } }]);
  });

  it('a tick or untick in the editor is reviewed before it is sent; nothing ticked cannot be saved', async () => {
    await mount({ connections: [growing] }, growing.id);
    await click(container.querySelector('[aria-label="Edit access to Platform"]'));
    const editor = q('team-access-editor')!;
    await click(q('team-mode-specific', editor));
    await click(button('Clear all', editor));
    expect((q('team-access-save', editor) as HTMLButtonElement).disabled).toBe(true);
    expect(q('team-access-review', editor)!.textContent).toContain('Tick at least one workspace in Platform');
    await click((all('picker-workspace', editor) as HTMLInputElement[]).find((b) => b.value === 'w2')!);
    expect(q('team-access-review', editor)!.textContent).toContain('2 workspaces it reaches today are no longer included.');
    expect(calls).toEqual([]);
  });

  it('a stale save shows the connection as it is now, keeps the edit open, and saves against the new revision', async () => {
    await mount({}, person.id);
    patchResult = () => ({ ok: false, code: 'stale_connection', error: 'This connection changed since you opened it.', connection: { ...person, revision: 5 } });
    await click(container.querySelector('[aria-label="Edit access to Platform"]'));
    await click(q('team-mode-all'));
    await click(q('team-access-save'));
    expect(q('team-access-error')!.textContent).toContain('changed since you opened it');
    expect(q('team-access-editor')).not.toBeNull();
    expect((q('team-mode-all') as HTMLInputElement).checked).toBe(true);
    patchResult = okResult;
    await click(q('team-access-save'));
    expect(calls.at(-1)).toEqual({ kind: 'patch', id: person.id, body: { teams: [{ teamId: 't1', mode: 'all' }], ifRevision: 5 } });
  });

  it('a failed save keeps the choice; one press sends one request', async () => {
    await mount({}, person.id);
    let release: (v: unknown) => void = () => {};
    patchResult = () => new Promise((r) => { release = r; });
    await click(container.querySelector('[aria-label="Edit access to Platform"]'));
    await click(q('team-mode-all'));
    await click(q('team-access-save'));
    expect((q('team-access-save') as HTMLButtonElement).disabled).toBe(true);
    expect(q('team-access-save')!.textContent).toBe('Saving…');
    await click(q('team-access-save'));
    expect(calls.filter((c) => c.kind === 'patch').length).toBe(1);
    await act(async () => { release({ ok: false, error: 'Could not reach buildd. Check your connection and try again.' }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(q('team-access-error')!.textContent).toContain('Your choices are kept');
    expect((q('team-mode-all') as HTMLInputElement).checked).toBe(true);
  });

  it('adds a team: all current and future workspaces by default, disclosed before Save', async () => {
    await mount({}, agent.id);
    await click(q('connection-add-team-open'));
    await click(container.querySelector('[aria-label="Choose access to Side"]'));
    const editor = q('team-access-editor')!;
    expect((q('team-mode-all', editor) as HTMLInputElement).checked).toBe(true);
    expect(q('team-access-review', editor)!.textContent).toContain('Hosted app gets every workspace in Side');
    await click(q('team-access-save', editor));
    expect(calls).toEqual([{ kind: 'patch', id: agent.id, body: { teams: [{ teamId: 't2', mode: 'all' }], ifRevision: 0 } }]);
  });

  it('the specific picker keeps ticks across search', async () => {
    await mount({}, person.id);
    await click(container.querySelector('[aria-label="Edit access to Platform"]'));
    const editor = q('team-access-editor')!;
    await click((all('picker-workspace', editor) as HTMLInputElement[]).find((b) => b.value === 'w2')!);
    const search = editor.querySelector('input[type="search"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(search, 'docs'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect((all('picker-workspace', editor) as HTMLInputElement[]).map((b) => b.value)).toEqual(['w3']);
    expect(q('picker-count', editor)!.textContent).toContain('2 of 3 ticked');
    await click(q('team-access-save', editor));
    expect(calls).toEqual([{ kind: 'patch', id: person.id, body: { teams: [{ teamId: 't1', mode: 'specific', workspaceIds: ['w1', 'w2'] }], ifRevision: 2 } }]);
  });

  it('switches between read only and read and write', async () => {
    await mount({}, agent.id);
    await click(button('Read and write'));
    expect(calls).toEqual([{ kind: 'patch', id: agent.id, body: { access: 'read-write', ifRevision: 0 } }]);
  });

  it('a person connection can be made an agent, after a confirm', async () => {
    await mount({}, person.id);
    expect(q('connection-kind')!.textContent).toContain('force a review, override a merge, abandon work.');
    expect(q('connection-kind')!.textContent).not.toMatch(/landing/i);
    await click(q('connection-make-agent'));
    expect(calls).toEqual([]);
    await click(q('connection-make-agent-confirm'));
    expect(calls).toEqual([{ kind: 'patch', id: person.id, body: { actsAs: 'agent', ifRevision: 2 } }]);
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

  it('legacy per-workspace connections are folded under one quiet line, with no command to run', async () => {
    await mount({ legacy: [{ clientName: 'Old app', workspaceName: 'api', lastActiveAt: '2026-10-08T10:00:00Z' }] });
    const n = q('connections-legacy')!;
    expect(n.textContent).toContain('Older connections');
    expect(n.textContent).not.toContain('Old app');
    await click(n.querySelector('button[aria-expanded]'));
    expect(n.textContent).toContain('Old app');
    expect(n.textContent).toContain('Connecting the app again replaces them.');
    expect(container.textContent).not.toContain('buildd install');
  });

  it('empty: plain text, no frame', async () => {
    await mount({ connections: [] });
    const e = q('connections-empty')!;
    expect(e.tagName).toBe('P');
    expect(e.textContent).toContain('No apps.');
    expect(e.textContent).not.toContain('buildd install');
  });
});
