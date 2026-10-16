import { describe, expect, it } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

/** MCP get_decision, label_decision and get_decision_stats capability "*". */

const ctx = (level: 'worker' | 'admin'): ActionContext => ({
  authType: 'api', getLevel: async () => level, getWorkspaceId: async () => 'workspace-test',
});
const DECISION = '11111111-1111-4111-8111-111111111111';

describe('get_decision / label_decision', () => {
  it('are refused below admin level without a request', async () => {
    for (const action of ['get_decision', 'label_decision']) {
      const api = (async () => { throw new Error('must not fetch'); }) as ApiFn;
      const r = await handleBuilddAction(api, action, { decisionId: DECISION, label: 'right', rationale: 'r' }, ctx('worker'));
      expect(r.isError, action).toBe(true);
    }
  });

  it('get_decision reads the decision route', async () => {
    const calls: string[] = [];
    const api = (async (path: string) => { calls.push(path); return { decision: { id: DECISION } }; }) as ApiFn;
    const r = await handleBuilddAction(api, 'get_decision', { decisionId: DECISION }, ctx('admin'));
    expect(calls).toEqual([`/api/decisions/${DECISION}`]);
    expect(JSON.parse(r.content[0].text)).toEqual({ decision: { id: DECISION } });
  });

  it('label_decision posts the grade and says plainly when the first grade stands', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const api = (async (path: string, init?: { body?: string }) => {
      calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, label: 'conflict', existing: 'right', decisionId: DECISION };
    }) as ApiFn;
    const r = await handleBuilddAction(api, 'label_decision', { decisionId: DECISION, label: 'wrong', rationale: 'PR closed unmerged', ruleLabel: 'right' }, ctx('admin'));
    expect(calls).toEqual([{ path: `/api/decisions/${DECISION}/label`, body: { label: 'wrong', rationale: 'PR closed unmerged', ruleLabel: 'right' } }]);
    expect(r.content[0].text).toContain('already has the grade "right"');
  });

  it('require a decisionId', async () => {
    const api = (async () => { throw new Error('must not fetch'); }) as ApiFn;
    expect((await handleBuilddAction(api, 'get_decision', {}, ctx('admin'))).isError).toBe(true);
    expect((await handleBuilddAction(api, 'label_decision', { label: 'right' }, ctx('admin'))).isError).toBe(true);
  });
});

describe('get_decision_stats capability "*"', () => {
  it('reads one health readout per feature for the workspace, in the given window', async () => {
    const calls: string[] = [];
    const api = (async (path: string) => { calls.push(path); return { status: 'OK', features: [] }; }) as ApiFn;
    await handleBuilddAction(api, 'get_decision_stats', { capability: '*', since: '2026-01-05T00:00:00Z', until: '2026-01-12T00:00:00Z' }, ctx('worker'));
    const url = new URL(calls[0], 'https://example.test');
    expect(url.pathname).toBe('/api/decisions');
    expect(url.searchParams.get('features')).toBe('1');
    expect(url.searchParams.get('workspaceId')).toBe('workspace-test');
    expect(url.searchParams.get('capability')).toBeNull();
    expect(url.searchParams.get('since')).toBe('2026-01-05T00:00:00Z');
  });
});
