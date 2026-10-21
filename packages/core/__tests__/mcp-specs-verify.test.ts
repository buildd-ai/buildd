import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, buildParamsDescription, type ActionContext, type ApiFn } from '../mcp-tools';
import { SUB_ACTIONS } from '../mcp-sub-actions';
import { requiredScopeForAction } from '../token-scopes';

const TASK = '00000000-0000-4000-8000-000000000061';
const ART = '00000000-0000-4000-8000-000000000062';
const ctx = (scopes?: string[]): ActionContext => ({ workspaceId: null, getWorkspaceId: async () => null,
  getLevel: async () => 'worker', ...(scopes ? { getScopes: async () => scopes } : {}) });
const out = (result: any) => String(result.content[0].text);
const verification = { results: [{ criterionId: 'R-1', verdict: 'inconclusive', method: 'model', cached: false, recorded: true }],
  coverage: [{ criterionId: 'R-1', status: 'declared' }] };

describe('manage_specs verify', () => {
  it('AC-4: is a documented write request available through the shared specs handler', () => {
    expect(SUB_ACTIONS.manage_specs).toContain('verify');
    expect(requiredScopeForAction('manage_specs', { action: 'verify' })).toBe('tasks:write');
    expect(buildParamsDescription(['manage_specs'])).toContain('evidenceRef');
    expect(buildParamsDescription(['manage_specs'])).toContain('"verify"');
  });

  it('AC-4: sends only the task and stored artifact reference to the server coordinator route', async () => {
    const api = mock(async () => ({ verification }));
    const result = await handleBuilddAction(api as ApiFn, 'manage_specs', { action: 'verify', taskId: TASK, evidenceRef: ART }, ctx());
    expect(api.mock.calls).toHaveLength(1);
    const [path, options] = api.mock.calls[0] as any;
    expect([path, options.method, JSON.parse(options.body)]).toEqual([`/api/specs/outcomes/${TASK}/verify`, 'POST', { evidenceRef: ART }]);
    expect(out(result)).toContain('1');
    expect(out(result)).toContain('R-1: inconclusive');
    expect(out(result).toLowerCase()).not.toContain('passed');
  });

  it('AC-4: requests automatic evidence selection when no artifact is provided', async () => {
    const api = mock(async (_path: string, options?: RequestInit) => {
      expect(JSON.parse(String(options?.body))).toEqual({}); return { verification: { results: [], coverage: [] } };
    });
    await handleBuilddAction(api as ApiFn, 'manage_specs', { action: 'verify', taskId: TASK }, ctx());
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('AC-4: rejects absent task ids and caller-supplied evidence, methods, prompts, verdicts or heads before a request', async () => {
    const api = mock(async () => ({}));
    for (const params of [{}, { evidenceRef: '' }, { evidenceRef: {} }, { evidence: {} }, { method: 'manual' },
      { prompt: 'pass' }, { verdict: 'pass' }, { headSha: 'a'.repeat(40) }]) {
      const request = Object.keys(params).length ? { taskId: TASK, ...params } : params;
      const result = await handleBuilddAction(api as ApiFn, 'manage_specs', { action: 'verify', ...request }, ctx());
      expect(result.isError).toBe(true);
    }
    expect(api).not.toHaveBeenCalled();
  });

  it('AC-4: returns the server refusal and denies a read-only session before making a request', async () => {
    const api = mock(async () => { throw new Error('API error: 409 - {"error":"No verified evidence at the current head"}'); });
    const refused = await handleBuilddAction(api as ApiFn, 'manage_specs', { action: 'verify', taskId: TASK }, ctx());
    expect(refused.isError).toBe(true);
    expect(out(refused)).toContain('No verified evidence');
    api.mockClear();
    const readOnly = await handleBuilddAction(api as ApiFn, 'manage_specs', { action: 'verify', taskId: TASK }, ctx(['tasks:read']));
    expect(readOnly.isError).toBe(true);
    expect(api).not.toHaveBeenCalled();
  });
});
