import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, workerActions, adminActions, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';
import { SPEC_INLINE_BODY_MAX } from '../mcp-specs';
import { requiredScopeForAction } from '../token-scopes';

const WS = '00000000-0000-0000-0000-000000000001';
const SPEC = '00000000-0000-4000-8000-000000000051';
const ctx = (o: Partial<ActionContext> = {}): ActionContext => ({ workspaceId: WS, getWorkspaceId: async () => WS, getLevel: async () => 'worker', ...o });
const spec = { id: SPEC, title: 'Checkout', scope: 'feature', status: 'draft', version: 2, headRevision: 2, bodyArtifactId: 'art-1' };
const out = (r: any) => String(r.content[0].text);

describe('manage_specs', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });

  it('is a worker-level action whose reads need tasks:read and writes tasks:write', () => {
    expect(workerActions).toContain('manage_specs');
    expect(adminActions as readonly string[]).not.toContain('manage_specs');
    expect(requiredScopeForAction('manage_specs', { action: 'get' })).toBe('tasks:read');
    expect(requiredScopeForAction('manage_specs', { action: 'revise' })).toBe('tasks:write');
  });

  it('list and create_draft default to the session workspace', async () => {
    api.mockResolvedValueOnce({ specs: [spec] });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'list' }, ctx()))).toContain('Checkout');
    expect(api.mock.calls[0][0]).toBe(`/api/specs?workspaceId=${WS}`);

    api.mockResolvedValueOnce({ spec: { ...spec, version: 1 } });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'create_draft', title: 'Checkout', body: 'R-1: x', scope: 'feature' }, ctx()));
    const [endpoint, opts] = api.mock.calls[1];
    expect([endpoint, opts.method]).toEqual(['/api/specs', 'POST']);
    expect(JSON.parse(opts.body)).toEqual({ workspaceId: WS, title: 'Checkout', body: 'R-1: x', scope: 'feature' });
    expect(r).toContain('Version: 1');
  });

  it('get inlines a short body with its requirement ids and history', async () => {
    api.mockResolvedValueOnce({ spec, revision: { revision: 2, artifactRevision: 3, contentHash: 'abc' }, body: '# Checkout\nR-1: x', requirements: [{ id: 'R-1' }], revisions: [{ revision: 2, authorKind: 'agent', changeSummary: 'tighten' }, { revision: 1, authorKind: 'user' }] });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'get', specId: SPEC, revision: 2 }, ctx()));
    expect(api.mock.calls[0][0]).toBe(`/api/specs/${SPEC}?revision=2`);
    expect(r).toContain('R-1: x');
    expect(r).toContain('Requirement ids: R-1');
    expect(r).toContain('r2 by agent: tighten');
    expect(r).toContain('expectedVersion 2');
  });

  it('get points a long body at bounded artifact reads instead of inlining it', async () => {
    const body = 'x'.repeat(SPEC_INLINE_BODY_MAX + 1);
    api.mockResolvedValueOnce({ spec, revision: { revision: 2, artifactRevision: 3, contentHash: 'abc' }, body, requirements: [], revisions: [] });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'get', specId: SPEC }, ctx()));
    expect(r).not.toContain(body);
    expect(r).toContain('get_artifact { artifactId: "art-1", revision: 3, view: "outline" }');
  });

  it('a stale revise surfaces currentVersion and says how to recover, and writes are PATCHes', async () => {
    api.mockRejectedValueOnce(new Error('API error: 409 - {"error":"changed","code":"version_conflict","currentVersion":3}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: SPEC, expectedVersion: 2, body: 'new' }, ctx());
    expect(r.isError).toBe(true);
    expect(out(r)).toContain('currentVersion: 3');
    expect(out(r)).toContain('expectedVersion 3');
    const [endpoint, opts] = api.mock.calls[0];
    expect([endpoint, opts.method, JSON.parse(opts.body)]).toEqual([`/api/specs/${SPEC}`, 'PATCH', { expectedVersion: 2, body: 'new' }]);
  });

  it('revise requires expectedVersion; other API errors are not swallowed', async () => {
    await expect(handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: SPEC, body: 'b' }, ctx())).rejects.toThrow('expectedVersion');
    api.mockRejectedValueOnce(new Error('API error: 404 - {"error":"Spec not found"}'));
    await expect(handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'revise', specId: SPEC, expectedVersion: 1, body: 'b' }, ctx())).rejects.toThrow('404');
  });

  it('relate PUTs the parent, passes null through to clear it, and reports a cycle refusal', async () => {
    api.mockResolvedValueOnce({ spec: { ...spec, parentSpecId: 'p-1' } });
    expect(out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'relate', specId: SPEC, parentSpecId: 'p-1' }, ctx()))).toContain('Parent set');
    expect([api.mock.calls[0][0], api.mock.calls[0][1].method]).toEqual([`/api/specs/${SPEC}/parent`, 'PUT']);
    api.mockResolvedValueOnce({ spec: { ...spec, parentSpecId: null } });
    await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'relate', specId: SPEC, parentSpecId: null }, ctx());
    expect(JSON.parse(api.mock.calls[1][1].body)).toEqual({ parentSpecId: null });
    api.mockRejectedValueOnce(new Error('API error: 409 - {"error":"would form a cycle"}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'relate', specId: SPEC, parentSpecId: 'p-2' }, ctx());
    expect([r.isError, out(r)]).toEqual([true, 'would form a cycle']);
  });

  it('refuses an unknown sub-action, and no sub-action or param approves', async () => {
    await expect(handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'approve', specId: SPEC }, ctx())).rejects.toThrow('action must be one of');
    expect(api).not.toHaveBeenCalled();
    const docs = buildParamsDescription(['manage_specs']);
    expect(docs).not.toMatch(/\bstatus\?/);
    expect(docs).toContain('Nothing here approves');
  });
});
