/**
 * Acceptance tests for Living Specs "writing and approving a spec" revision 3,
 * "Retiring a spec": a draft or revision names the specs it replaces (R-76).
 * Written before the build; each fails until `replaces` is a field agents can
 * send. Over MCP, `create_draft` and `revise` forward it to the API as data, and
 * an agent that sends it can still not retire anything (AC-123).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, buildParamsDescription, type ApiFn, type ActionContext } from '../../../../packages/core/mcp-tools';

const WS = '00000000-0000-0000-0000-000000000001';
const OLD = '00000000-0000-4000-8000-0000000000a1';
const NEW = '00000000-0000-4000-8000-0000000000a2';
const ctx = (o: Partial<ActionContext> = {}): ActionContext => ({ workspaceId: WS, getWorkspaceId: async () => WS, getLevel: async () => 'worker', ...o });
const out = (r: any) => String(r.content[0].text);
const created = { spec: { id: NEW, title: 'Checkout v2', status: 'draft', version: 1 }, duplicateCheck: null, suggestedParent: null, formatHints: null };

describe('manage_specs replaces', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });

  it('R-76: create_draft and revise forward `replaces` as data, and the params text documents it', async () => {
    api.mockResolvedValueOnce(created);
    await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'create_draft', title: 'Checkout v2', body: '# Checkout v2\nR-1: x.', replaces: [OLD] }, ctx());
    expect(JSON.parse(api.mock.calls[0][1].body).replaces).toEqual([OLD]);

    api.mockResolvedValueOnce({ spec: { ...created.spec, version: 2 }, revision: { revision: 2 }, unchanged: false, formatHints: null });
    await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: NEW, expectedVersion: 1, body: '# Checkout v2\nR-1: y.', replaces: [OLD] }, ctx());
    expect(JSON.parse(api.mock.calls[1][1].body).replaces).toEqual([OLD]);

    expect(buildParamsDescription(['manage_specs'])).toContain('replaces?');
  });

  it('AC-123: an agent token\'s create_draft naming `replaces` is written; its retire is a 403 error result', async () => {
    api.mockResolvedValueOnce(created);
    const draft = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'create_draft', title: 'Checkout v2', body: '# Checkout v2\nR-1: x.', replaces: [OLD] }, ctx()));
    expect(draft).toContain('Spec draft created');
    expect(JSON.parse(api.mock.calls[0][1].body).replaces).toEqual([OLD]);

    api.mockRejectedValueOnce(new Error('API error: 403 - {"error":"Retiring a spec is a person\'s decision"}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'retire', specId: OLD, reason: 'Replaced by Checkout v2', supersededBy: NEW }, ctx());
    expect(r.isError).toBe(true);
    expect(out(r)).toContain('person');
  });
});
