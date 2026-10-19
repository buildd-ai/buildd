import { describe, expect, it } from 'bun:test';
import { ANALYTICS_READ_ACTIONS, handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

/**
 * Spec workspace-routing-and-reach I-22 / AC-11: a failed analytics read
 * answers with a read status first (FORBIDDEN / UNAUTHORIZED /
 * TOOL_UNAVAILABLE) and says it is not evidence, never a raw API error a
 * reviewer could read as "nothing there".
 */

const WS = '00000000-0000-4000-8000-0000000000aa';
const ctx: ActionContext = { authType: 'api', getLevel: async () => 'admin', getWorkspaceId: async () => WS };

const throwing = (message: string): ApiFn => (async () => { throw new Error(message); }) as unknown as ApiFn;

async function reply(api: ApiFn, action: string, params: Record<string, unknown> = { workspaceId: WS }) {
  const r = await handleBuilddAction(api, action, params, ctx);
  return { isError: r.isError, text: r.content.map(c => ('text' in c ? c.text : '')).join('\n') };
}

describe('analytics read failures carry a read status', () => {
  it('covers every analytics read in the spec, and only reads', () => {
    expect([...ANALYTICS_READ_ACTIONS].sort()).toEqual([
      'dispatch_health', 'explain', 'get_decision_stats', 'get_error_traces', 'get_failure_analytics',
      'get_manifest_coverage', 'get_path_claim_stats', 'get_usage_stats',
    ]);
  });

  for (const action of ANALYTICS_READ_ACTIONS) {
    it(`${action}: a workspace outside reach answers FORBIDDEN, not evidence`, async () => {
      const r = await reply(throwing('API error: 404 - {"error":"Workspace not found"}'), action);
      expect(r.isError).toBe(true);
      expect(r.text.startsWith('FORBIDDEN:')).toBe(true);
      expect(r.text).toContain('did not reach the data');
    });

    it(`${action}: a rejected token answers UNAUTHORIZED`, async () => {
      const r = await reply(throwing('API error: 401 - {"error":"Unauthorized"}'), action);
      expect(r.text.startsWith('UNAUTHORIZED:')).toBe(true);
    });

    it(`${action}: a server failure answers TOOL_UNAVAILABLE`, async () => {
      const r = await reply(throwing('API error: 500 - {"error":"boom"}'), action);
      expect(r.text.startsWith('TOOL_UNAVAILABLE:')).toBe(true);
    });
  }

  it('a workspace name the key cannot see answers FORBIDDEN', async () => {
    const api = (async (path: string) => {
      if (path === '/api/workspaces') return { workspaces: [{ id: WS, name: 'mine' }] };
      throw new Error(`unexpected ${path}`);
    }) as unknown as ApiFn;
    const r = await reply(api, 'get_usage_stats', { workspaceId: 'elsewhere' });
    expect(r.text.startsWith('FORBIDDEN:')).toBe(true);
    expect(r.text).toContain('not visible to this key');
  });

  it('a non-analytics action still surfaces its raw error', async () => {
    await expect(handleBuilddAction(throwing('API error: 500 - boom'), 'list_runners', { workspaceId: WS }, ctx)).rejects.toThrow('API error: 500');
  });
});
