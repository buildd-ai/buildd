/**
 * A bare name like "buildd" can match several reachable workspaces (a name
 * match on one, a repo-suffix match on another). First-in-list order must not
 * decide: an exact name/repo match wins, then the connection's own workspace.
 */
import { describe, it, expect } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const OWN = '00000000-0000-0000-0000-0000000000a1';
const SUFFIX = '00000000-0000-0000-0000-0000000000b2';
const EXACT = '00000000-0000-0000-0000-0000000000c3';

function run(workspaces: Array<{ id: string; name: string; repo?: string }>, ctxWs: string) {
  const calls: string[] = [];
  const api = (async (endpoint: string) => {
    calls.push(endpoint);
    if (endpoint === '/api/workspaces') return { workspaces };
    return {};
  }) as unknown as ApiFn;
  const ctx: ActionContext = {
    authType: 'api',
    workspaceId: ctxWs,
    getWorkspaceId: async () => ctxWs,
    getLevel: async () => 'admin',
  };
  return handleBuilddAction(api, 'get_failure_analytics', { workspaceId: 'buildd' }, ctx).then(() => calls);
}

describe('ambiguous workspace name', () => {
  it('prefers an exact name match over an earlier repo-suffix match', async () => {
    const calls = await run(
      [{ id: SUFFIX, name: 'fork', repo: 'other/buildd' }, { id: EXACT, name: 'buildd', repo: 'org/x' }],
      '00000000-0000-0000-0000-0000000000ff',
    );
    expect(calls.some((c) => c.includes(`workspaceId=${EXACT}`))).toBe(true);
  });

  it('among equally good matches prefers the connection workspace', async () => {
    const calls = await run(
      [{ id: SUFFIX, name: 'fork', repo: 'other/buildd' }, { id: OWN, name: 'mine', repo: 'org/buildd' }],
      OWN,
    );
    expect(calls.some((c) => c.includes(`workspaceId=${OWN}`))).toBe(true);
  });
});
