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
