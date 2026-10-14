/**
 * manage_specs retire / restore (living-specs.md §22): a person takes a spec
 * out of force, retired or superseded by another, and puts it back, over
 * POST|DELETE /api/specs/[id]/retire, whose 403 for an agent run passes
 * through as an error result.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';
import { requiredScopeForAction } from '../token-scopes';
import { SUB_ACTIONS } from '../mcp-sub-actions';

const WS = '00000000-0000-0000-0000-000000000001';
const SPEC = '00000000-0000-4000-8000-000000000071';
const NEXT = '00000000-0000-4000-8000-000000000072';
const ctx = (o: Partial<ActionContext> = {}): ActionContext => ({ workspaceId: WS, getWorkspaceId: async () => WS, getLevel: async () => 'worker', ...o });
const out = (r: any) => String(r.content[0].text);
const REASON = 'A duplicate of the checkout spec';

describe('manage_specs retire / restore', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });

  it('are registered sub-actions, documented, and write-scoped', () => {
    expect(SUB_ACTIONS.manage_specs).toContain('retire');
    expect(SUB_ACTIONS.manage_specs).toContain('restore');
    expect(buildParamsDescription(['manage_specs'])).toContain('"retire" | "restore"');
    expect(buildParamsDescription(['manage_specs'])).toContain('retire { specId, reason');
    expect(requiredScopeForAction('manage_specs', { action: 'retire' })).toBe('tasks:write');
    expect(requiredScopeForAction('manage_specs', { action: 'restore' })).toBe('tasks:write');
  });

  it('retire POSTs reason and supersededBy and says it is superseded', async () => {
    api.mockResolvedValueOnce({ spec: { id: SPEC, title: 'Checkout', status: 'superseded', version: 4 } });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'retire', specId: SPEC, reason: REASON, supersededBy: NEXT }, ctx()));
    const [endpoint, opts] = api.mock.calls[0];
    expect([endpoint, opts.method]).toEqual([`/api/specs/${SPEC}/retire`, 'POST']);
    expect(JSON.parse(opts.body)).toEqual({ reason: REASON, supersededBy: NEXT });
    expect(r).toContain('Superseded');
    expect(r).toContain('restore');
  });

  it('retire without a reason is refused before any call', async () => {
    await expect(handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'retire', specId: SPEC }, ctx())).rejects.toThrow('reason');
    expect(api).not.toHaveBeenCalled();
  });

  it('an agent run\'s 403 comes back as an error result', async () => {
    api.mockRejectedValueOnce(new Error('API error: 403 - {"error":"Retiring a spec is a person\'s decision"}'));
    const r: any = await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'retire', specId: SPEC, reason: REASON }, ctx());
    expect(r.isError).toBe(true);
    expect(out(r)).toContain('person');
  });

  it('restore DELETEs and says the status it is back at', async () => {
    api.mockResolvedValueOnce({ spec: { id: SPEC, title: 'Checkout', status: 'approved', version: 5 } });
    const r = out(await handleBuilddAction(api as unknown as ApiFn, 'manage_specs', { action: 'restore', specId: SPEC }, ctx()));
    expect([api.mock.calls[0][0], api.mock.calls[0][1].method]).toEqual([`/api/specs/${SPEC}/retire`, 'DELETE']);
    expect(r).toContain('approved again');
  });
});
