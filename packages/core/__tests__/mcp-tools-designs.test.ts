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

  it('a worker token may call them: store and attach need tasks:write, list needs tasks:read', () => {
    for (const a of ['store_design', 'manage_designs']) expect(requiredScopeForAction(a)).toBe('tasks:write');
    expect(requiredScopeForAction('manage_designs', { action: 'list' })).toBe('tasks:read');
  });
});
