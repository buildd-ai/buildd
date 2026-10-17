/**
 * manage_specs copy (living-specs.md §25): the cross-workspace handoff over
 * POST /api/specs/[id]/copy. The reply a destination runner waits on names the
 * verified spec id, revision and hash, or the refusal by code; a get that 404s
 * says the route's text (the copy to use, or how to make one) instead of
 * throwing a raw API error.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';
import { requiredScopeForAction } from '../token-scopes';
import { SUB_ACTIONS } from '../mcp-sub-actions';

const WS = '00000000-0000-0000-0000-000000000001';
const DEST = '00000000-0000-0000-0000-000000000002';
const SPEC = '00000000-0000-4000-8000-000000000081';
const COPY = '00000000-0000-4000-8000-000000000082';
const HASH = 'a'.repeat(64);
const ctx = (o: Partial<ActionContext> = {}): ActionContext => ({ workspaceId: WS, getWorkspaceId: async () => WS, getLevel: async () => 'worker', ...o });
const out = (r: any) => String(r.content[0].text);
const reply = (o: Record<string, unknown> = {}) => ({
  reused: false, verified: true,
  source: { workspaceId: WS, specId: SPEC, revision: 2, contentHash: HASH, approved: true },
  destination: { workspaceId: DEST, specId: COPY, revision: 1, contentHash: HASH, version: 1, status: 'draft', approved: false },
  notCarried: ['attachments (they live in the source workspace)'],
  ...o,
});

describe('manage_specs copy', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });

  it('is a registered sub-action, documented, and write-scoped', () => {
    expect(SUB_ACTIONS.manage_specs).toContain('copy');
    expect(buildParamsDescription(['manage_specs'])).toContain('"restore" | "copy"');
    expect(buildParamsDescription(['manage_specs'])).toContain('copy { specId, targetWorkspaceId');
    expect(requiredScopeForAction('manage_specs', { action: 'copy' })).toBe('tasks:write');
  });

  it('POSTs the destination, revision and hash, and reports the verified destination spec id, revision and hash', async () => {
    api.mockResolvedValueOnce(reply());
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'copy', specId: SPEC, targetWorkspaceId: DEST, revision: 2, expectedContentHash: HASH }, ctx()));
    const [endpoint, opts] = api.mock.calls[0];
    expect([endpoint, opts.method]).toEqual([`/api/specs/${SPEC}/copy`, 'POST']);
    expect(JSON.parse(opts.body)).toEqual({ targetWorkspaceId: DEST, revision: 2, expectedContentHash: HASH });
    expect(r).toContain(`spec ${SPEC} revision 2 is spec ${COPY} revision 1 in workspace ${DEST}`);
    expect(r).toContain(`sha256 ${HASH}`);
    expect(r).toContain('Not approved in the destination');
    expect(r).toContain('Not carried: attachments');
  });

  it('a retry says nothing new was written', async () => {
    api.mockResolvedValueOnce(reply({ reused: true }));
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'copy', specId: SPEC, targetWorkspaceId: DEST }, ctx()));
    expect(r).toContain('Already copied (nothing new written)');
  });

  it('a destination named by workspace name resolves among the listed workspaces', async () => {
    api.mockResolvedValueOnce({ workspaces: [{ id: WS, name: 'buildd' }, { id: DEST, name: 'buildd-admin' }] });
    api.mockResolvedValueOnce(reply());
    await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'copy', specId: SPEC, targetWorkspaceId: 'buildd-admin' }, ctx());
    expect(api.mock.calls[0][0]).toBe('/api/workspaces');
    expect(JSON.parse(api.mock.calls[1][1].body).targetWorkspaceId).toBe(DEST);
  });

  it('a task token naming another workspace is refused by name, never resolved to its own workspace', async () => {
    api.mockRejectedValueOnce(new Error('API error: 401 - {"error":"Unauthorized"}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'copy', specId: SPEC, targetWorkspaceId: 'buildd-admin' }, ctx());
    expect(r.isError).toBe(true);
    expect(out(r)).toContain('spec_copy_destination');
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('a refusal comes back as an error result carrying its code', async () => {
    api.mockRejectedValueOnce(new Error('API error: 409 - {"error":"Revision 1 is older than the approved revision 2; nothing was copied.","code":"spec_copy_stale"}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'copy', specId: SPEC, targetWorkspaceId: DEST, revision: 1 }, ctx());
    expect(r.isError).toBe(true);
    expect(out(r)).toContain('Not copied (spec_copy_stale)');
    expect(out(r)).toContain('older than the approved revision 2');
  });

  it('without targetWorkspaceId it is refused before any call', async () => {
    await expect(handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'copy', specId: SPEC }, ctx())).rejects.toThrow('targetWorkspaceId');
    expect(api).not.toHaveBeenCalled();
  });

  it('a get that 404s returns the route\'s text, which names the copy to use', async () => {
    api.mockRejectedValueOnce(new Error(`API error: 404 - {"error":"Spec ${SPEC} is not readable from here, but it was copied into a workspace you can read: ${COPY}. Use that spec id.","code":"spec_copied"}`));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'get', specId: SPEC }, ctx());
    expect(r.isError).toBe(true);
    expect(out(r)).toContain(COPY);
  });
});
