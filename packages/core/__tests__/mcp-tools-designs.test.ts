import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';
import { requiredScopeForAction } from '../token-scopes';

const ctx: ActionContext = { authType: 'oauth', getWorkspaceId: async () => null, getLevel: async () => 'worker' };
const D = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';

function recording(reply: Record<string, unknown>) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const api: ApiFn = async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return reply;
  };
  return { api, calls };
}
const run = async (api: ApiFn, action: string, params: Record<string, unknown>) => String((await handleBuilddAction(api, action, params, ctx)).content[0].text);

describe('design actions', () => {
  it('store_design posts the export once and reports revision, screens and the attachment', async () => {
    const { api, calls } = recording({
      design: { id: D, title: 'T', revision: 1, screens: [{ id: 'a', name: 'A', viewport: '390x844' }] },
      attached: { linkId: 'L1', pinnedRevision: null },
    });
    const out = await run(api, 'store_design', { html: '<html></html>', title: 'T', attachTo: { kind: 'mission', id: M } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/api/artifacts/designs', method: 'POST', body: { html: '<html></html>', attachTo: { kind: 'mission', id: M } } });
    expect(out).toContain('revision 1');
    expect(out).toContain('a (A, 390x844)');
    expect(out).toContain('L1');
  });

  it('store_design says so when it stored but could not attach', async () => {
    const { api } = recording({ design: { id: D, title: 'T', revision: 1, screens: [] }, attached: null, attachError: 'mission not found' });
    expect(await run(api, 'store_design', { html: '<html></html>' })).toContain('not attached: mission not found');
  });

  it('refuses a call missing its required params before any request', async () => {
    const { api, calls } = recording({});
    await expect(run(api, 'store_design', {})).rejects.toThrow('html is required');
    await expect(run(api, 'manage_designs', { action: 'attach', designId: D, kind: 'task' })).rejects.toThrow('id is required');
    await expect(run(api, 'manage_designs', { action: 'detach', designId: D })).rejects.toThrow('linkId is required');
    expect(calls).toHaveLength(0);
  });

  it('manage_designs attaches, detaches and lists through the routes', async () => {
    const attach = recording({ link: { id: 'L1', artifactId: D, subjectKind: 'spec_revision', subjectId: M, artifactRevision: 2 } });
    expect(await run(attach.api, 'manage_designs', { action: 'attach', designId: D, kind: 'spec', id: M })).toContain('pinned to revision 2');
    expect(attach.calls[0]).toMatchObject({ path: `/api/artifacts/designs/${D}/attach`, method: 'POST' });

    const detach = recording({ ok: true });
    await run(detach.api, 'manage_designs', { action: 'detach', designId: D, linkId: 'L1' });
    expect(detach.calls[0]).toMatchObject({ path: `/api/artifacts/designs/${D}/attach?linkId=L1`, method: 'DELETE' });

    const list = recording({ designs: [{ id: D, title: 'T', revision: 3, screens: [{ id: 'a' }], linkId: 'L1' }] });
    const out = await run(list.api, 'manage_designs', { action: 'list', missionId: M });
    expect(list.calls[0]).toMatchObject({ path: `/api/artifacts/designs?missionId=${M}`, method: 'GET' });
    expect(out).toContain('revision 3');
  });

  it('manage_designs list shows a screen\'s kind and code (AC-11)', async () => {
    const list = recording({ designs: [{ id: D, title: 'T', revision: 1, screens: [
      { id: 'c-row', name: 'Row', viewport: '360x120', kind: 'component', code: 'apps/web/src/components/X.tsx' },
      { id: 'home', name: 'Home', viewport: '1440x900' },
    ] }] });
    const out = await run(list.api, 'manage_designs', { action: 'list', missionId: M });
    expect(out).toContain('c-row (component, apps/web/src/components/X.tsx)');
    expect(out).toContain('home');
    expect(out).not.toContain('home (');
  });

  it('manage_designs screen reads one board of one revision: its source and a render at its viewport (AC-12)', async () => {
    const reply = recording({
      design: { id: D, title: 'Delivery', revision: 2 },
      screen: { id: 'c-row', name: 'Row', viewport: '360x120', kind: 'component', code: 'apps/web/src/components/X.tsx' },
      source: { html: '<!doctype html><section data-screen="c-row">Row board</section>', bytes: 60, truncated: false },
      render: { url: 'https://storage.example/d.html?sig=1#c-row', viewport: '360x120', page: `/app/artifacts/${D}?screen=c-row&revision=2` },
    });
    const out = await run(reply.api, 'manage_designs', { action: 'screen', designId: D, revision: 2, screenId: 'c-row' });
    expect(reply.calls[0]).toMatchObject({ path: `/api/artifacts/designs/${D}/screens/c-row?revision=2`, method: 'GET' });
    expect(out).toContain('Row board');
    expect(out).toContain('https://storage.example/d.html?sig=1#c-row');
    expect(out).toContain('360x120');
    expect(out).toContain('component');
    expect(out).toContain('apps/web/src/components/X.tsx');
    await expect(run(reply.api, 'manage_designs', { action: 'screen', designId: D })).rejects.toThrow('screenId is required');
  });

  it('a worker token may call them: store and attach need tasks:write, list and screen need tasks:read', () => {
    for (const a of ['store_design', 'manage_designs']) expect(requiredScopeForAction(a)).toBe('tasks:write');
    expect(requiredScopeForAction('manage_designs', { action: 'list' })).toBe('tasks:read');
    expect(requiredScopeForAction('manage_designs', { action: 'screen' })).toBe('tasks:read');
  });

  it('get_task lists attached designs with their screen names and sizes', async () => {
    const T = '33333333-3333-4333-8333-333333333333';
    const api: ApiFn = async (path) => {
      if (path.startsWith('/api/artifacts/designs')) {
        return { designs: [{ id: D, title: 'Nav', revision: 2, pinnedRevision: 2, linkId: 'L1', screens: [{ id: 'nav-home', name: 'Home', viewport: '390x844' }] }] };
      }
      return { id: T, title: 'Navigation', status: 'pending', priority: 0, workers: [], artifacts: [] };
    };
    const out = await run(api, 'get_task', { taskId: T });
    expect(out).toContain('## Designs (1)');
    expect(out).toContain('screen nav-home: Home (390x844)');
  });
});
