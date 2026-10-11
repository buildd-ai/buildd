/**
 * merge_pr's landing escape hatch: `overrides` + `reason` reach the merge
 * route; from chat (a signed-in person, in process) the merge goes through the
 * dashboard's own merge route, whose rails are the landing page's.
 */
import { describe, expect, it } from 'bun:test';
import { buildParamsDescription, handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

function makeApi(answer: Record<string, unknown> = { merged: true, message: 'merged', pr: { number: 42, url: 'u' } }) {
  const calls: Array<{ endpoint: string; method?: string; body: any }> = [];
  const api = (async (endpoint: string, init?: { method?: string; body?: string }) => {
    calls.push({ endpoint, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return answer;
  }) as unknown as ApiFn;
  return { api, calls };
}

const ctx = (o: Partial<ActionContext> = {}): ActionContext => ({
  authType: 'oauth', getWorkspaceId: async () => null, getLevel: async () => 'worker', ...o,
});

describe('merge_pr overrides', () => {
  it('forwards overrides and reason to PUT /api/github/pr', async () => {
    const { api, calls } = makeApi();
    await handleBuilddAction(api, 'merge_pr', { prNumber: 42, overrides: { freshness: true }, reason: 'base keeps moving' }, ctx());
    expect(calls[0]).toMatchObject({ endpoint: '/api/github/pr', method: 'PUT', body: { prNumber: 42, overrides: { freshness: true }, reason: 'base keeps moving' } });
  });

  it('without overrides sends neither field', async () => {
    const { api, calls } = makeApi();
    await handleBuilddAction(api, 'merge_pr', { prNumber: 42 }, ctx());
    expect(calls[0]!.body).not.toHaveProperty('overrides');
    expect(calls[0]!.body).not.toHaveProperty('reason');
  });

  it('from chat it merges through the dashboard merge route, as the signed-in person', async () => {
    const { api, calls } = makeApi({ ok: true, merged: true, message: 'merged' });
    const out: any = await handleBuilddAction(api, 'merge_pr', { prNumber: 42, workspaceId: 'ws-1', overrides: { freshness: true }, reason: 'r' }, ctx({ surface: 'chat' }));
    expect(calls[0]).toMatchObject({ endpoint: '/api/prs/42/merge', method: 'POST', body: { workspaceId: 'ws-1', overrides: { freshness: true }, reason: 'r' } });
    expect(String(out.content[0].text)).toContain('merged');
  });

  it('documents the escape hatch and who may use it', () => {
    const doc = buildParamsDescription(['merge_pr']);
    expect(doc).toContain('overrides?');
    expect(doc).toContain('landingOverride');
  });
});
