/**
 * Transport parity: every `buildd` action in packages/core/mcp-tools.ts is
 * reachable on every MCP transport, so adding one can never leave a transport
 * answering "Unknown action" (PR #1875 shipped exactly that).
 *
 * Transports: /api/mcp (API keys, task tokens, account-level OAuth grants),
 * on both its group-tool and legacy one-tool surfaces, and the deprecated
 * per-workspace OAuth endpoint /api/mcp-oauth/[workspace]. All of them hand
 * every action to the one shared handleBuilddAction.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/app/api/mcp/transport-parity.test.ts
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { allActions, handleBuilddAction, triggerActions, type ActionContext } from '@buildd/core/mcp-tools';
import { ACTION_TOKEN_SCOPE } from '@buildd/core/token-scopes';
import { listMcpTools } from './tools';
import { READ_GRANT_TOKEN_SCOPES } from '@/lib/mcp-grants';

type Tool = { name: string; inputSchema?: { properties?: { action?: { enum?: string[] } } } };

function actionsOn(tools: object[]): Set<string> {
  const out = new Set<string>();
  for (const t of tools as Tool[]) for (const a of t.inputSchema?.properties?.action?.enum ?? []) out.add(a);
  return out;
}

const SOURCE = (rel: string) => readFileSync(join(import.meta.dir, rel), 'utf8');

describe('every action is served by every transport', () => {
  for (const surface of ['groups', 'legacy'] as const) {
    it(`/api/mcp ${surface} surface lists every action at admin level`, () => {
      const listed = actionsOn(listMcpTools({ accountLevel: 'admin', isSensitive: false, surface }));
      const missing = allActions.filter((a) => !listed.has(a));
      expect(missing).toEqual([]);
    });
  }

  it('every action has a token scope, so scoped and read-only grant sessions can gate it', () => {
    for (const a of allActions) expect(Object.hasOwn(ACTION_TOKEN_SCOPE, a)).toBe(true);
  });

  it('the per-workspace OAuth endpoint serves the shared action list through the shared handler', () => {
    const src = SOURCE('../mcp-oauth/[workspace]/route.ts');
    expect(src).toContain('allActions as allActionsList');
    expect(src).toContain('const actions = [...allActionsList];');
    expect(src).toContain('handleBuilddAction(api, action, params, ctx)');
  });

  it('/api/mcp hands buildd and group-tool calls to the shared handler', () => {
    expect(SOURCE('route.ts')).toContain('return await handleBuilddAction(api, action, params, ctx);');
  });
});

describe('list_workspaces (the discovery action) on every transport', () => {
  it('is listed for every level, on both surfaces, and for a read-only grant session', () => {
    for (const surface of ['groups', 'legacy'] as const) {
      for (const accountLevel of ['trigger', 'worker', 'admin'] as const) {
        expect(actionsOn(listMcpTools({ accountLevel, isSensitive: false, surface })).has('list_workspaces')).toBe(true);
      }
      expect(actionsOn(listMcpTools({ accountLevel: 'worker', isSensitive: false, surface, scopes: [...READ_GRANT_TOKEN_SCOPES] })).has('list_workspaces')).toBe(true);
    }
    expect((triggerActions as readonly string[]).includes('list_workspaces')).toBe(true);
  });

  const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
    getWorkspaceId: async () => null,
    getLevel: async () => 'worker',
    ...over,
  });

  it('API-key transports list what the workspace route returns, at the key\'s level', async () => {
    const calls: string[] = [];
    const api = async (endpoint: string) => {
      calls.push(endpoint);
      return { workspaces: [{ id: 'w1', name: 'one', repo: 'o/one', teamId: 't1' }, { id: 'w2', name: 'two', teamId: 't1' }] };
    };
    const r = await handleBuilddAction(api, 'list_workspaces', {}, ctx());
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual(['/api/workspaces']);
    const out = JSON.parse(r.content[0].text);
    expect(out.total).toBe(2);
    expect(out.teams[0].workspaces).toEqual([
      { id: 'w1', name: 'one', repo: 'o/one', level: 'worker' },
      { id: 'w2', name: 'two', level: 'worker' },
    ]);
  });

  it('a grant transport lists its own set and never calls the route', async () => {
    const api = async () => { throw new Error('no route call expected'); };
    const r = await handleBuilddAction(api, 'list_workspaces', { limit: 1 }, ctx({
      listWorkspaces: async () => [
        { workspaceId: 'a', name: 'A', teamId: 't1', teamName: 'T1', level: 'admin', access: 'read-write' },
        { workspaceId: 'b', name: 'B', teamId: 't2', teamName: 'T2', level: 'worker', access: 'read-write' },
      ],
    }));
    const out = JSON.parse(r.content[0].text);
    expect(out).toMatchObject({ total: 2, offset: 0, limit: 1, nextOffset: 1 });
    expect(out.teams).toEqual([{ teamId: 't1', teamName: 'T1', workspaces: [{ id: 'a', name: 'A', level: 'admin', access: 'read-write' }] }]);
  });

  it('a read-only grant session may call it', async () => {
    const r = await handleBuilddAction(async () => ({ workspaces: [] }), 'list_workspaces', {}, ctx({ getScopes: async () => [...READ_GRANT_TOKEN_SCOPES] }));
    expect(r.isError).toBeFalsy();
  });
});
