import { describe, expect, it } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';
const ctx: ActionContext = {
  authType: 'api', getLevel: async () => 'worker',
  getWorkspaceId: async () => 'workspace-test',
};
describe('coordination analytics REST transport', () => {
  for (const [action, metric] of [['get_manifest_coverage', 'manifest'], ['get_path_claim_stats', 'pathClaims']]) {
    it(`${action} makes one REST call with scoped filters`, async () => {
      const calls: string[] = [];
      const api = (async (path: string) => { calls.push(path); return { [metric === 'manifest' ? 'manifestCoverage' : 'pathClaims']: { total: 3 }, coverage: 'ledger' }; }) as ApiFn;
      const result = await handleBuilddAction(api, action, { missionId: 'mission-test', window: '24h' }, ctx);
      expect(calls).toHaveLength(1);
      const url = new URL(calls[0], 'https://example.test');
      expect(url.pathname).toBe('/api/stats/coordination');
      expect(url.searchParams.get('mission')).toBe('mission-test');
      expect(url.searchParams.get('window')).toBe('24h');
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain('3');
    });
    it(`${action} rejects unsupported windows without fetching`, async () => {
      const api = (async () => { throw new Error('must not fetch'); }) as ApiFn;
      const result = await handleBuilddAction(api, action, { window: 'forever' }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid window');
    });
  }
});
describe('get_decision_stats', () => {
  it('reads the decision-ledger metric through the coordination route', async () => {
    const calls: string[] = [];
    const api = (async (path: string) => { calls.push(path); return { decisions: { total: 4, labelled: 1 } }; }) as ApiFn;
    const result = await handleBuilddAction(api, 'get_decision_stats', { missionId: 'mission-test', window: '30d' }, ctx);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0], 'https://example.test');
    expect(url.pathname).toBe('/api/stats/coordination');
    expect(url.searchParams.get('metric')).toBe('orchestrationDecisions');
    expect(url.searchParams.get('mission')).toBe('mission-test');
    expect(url.searchParams.get('window')).toBe('30d');
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ status: 'OK', decisions: { total: 4, labelled: 1 } });
  });
  it('says NO_DATA when the read succeeded with zero rows', async () => {
    const api = (async () => ({ decisions: { total: 0 }, manifestPredictions: { total: 0 } })) as ApiFn;
    const result = await handleBuilddAction(api, 'get_decision_stats', {}, ctx);
    expect(JSON.parse(result.content[0].text).status).toBe('NO_DATA');
  });
  it('with capability, reads the decision ledger for that workspace in a pinned window', async () => {
    const calls: string[] = [];
    const api = (async (path: string) => { calls.push(path); return { status: 'OK', count: 2, decisions: [{}, {}] }; }) as ApiFn;
    const result = await handleBuilddAction(api, 'get_decision_stats', {
      capability: 'question_gate', since: '2026-01-01T00:00:00Z', until: '2026-01-08T00:00:00Z', limit: 200, overriddenOnly: true,
    }, ctx);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0], 'https://example.test');
    expect(url.pathname).toBe('/api/decisions');
    expect(url.searchParams.get('workspaceId')).toBe('workspace-test');
    expect(url.searchParams.get('capability')).toBe('question_gate');
    expect(url.searchParams.get('since')).toBe('2026-01-01T00:00:00Z');
    expect(url.searchParams.get('until')).toBe('2026-01-08T00:00:00Z');
    expect(url.searchParams.get('limit')).toBe('200');
    expect(url.searchParams.get('overriddenOnly')).toBe('true');
    expect(JSON.parse(result.content[0].text).status).toBe('OK');
  });
  it('ledger-only filters without capability are refused rather than ignored', async () => {
    const api = (async () => { throw new Error('must not fetch'); }) as ApiFn;
    const result = await handleBuilddAction(api, 'get_decision_stats', { since: '2026-01-01T00:00:00Z' }, ctx);
    expect(result.isError).toBe(true);
  });
  // The blind weekly review: access failures must never read as zero decisions.
  for (const [thrown, status] of [
    ['API error: 403 - {"error":"forbidden"}', 'FORBIDDEN'],
    ['API error: 404 - {"error":"Workspace not found"}', 'FORBIDDEN'],
    ['API error: 401 - {"error":"Unauthorized"}', 'UNAUTHORIZED'],
    ['API error: 503 - {"status":"TOOL_UNAVAILABLE"}', 'TOOL_UNAVAILABLE'],
    ['fetch failed', 'TOOL_UNAVAILABLE'],
  ] as const) {
    it(`a ${status} read (${thrown.slice(0, 14)}) is an error naming its status, never NO_DATA`, async () => {
      const api = (async () => { throw new Error(thrown); }) as ApiFn;
      const result = await handleBuilddAction(api, 'get_decision_stats', { capability: 'question_gate' }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text.startsWith(`${status}:`)).toBe(true);
      expect(result.content[0].text).not.toContain('NO_DATA');
      expect(result.content[0].text).toContain('never as "no issues"');
    });
  }
  it('rejects unsupported windows without fetching', async () => {
    const api = (async () => { throw new Error('must not fetch'); }) as ApiFn;
    const result = await handleBuilddAction(api, 'get_decision_stats', { window: '90d' }, ctx);
    expect(result.isError).toBe(true);
  });
});
