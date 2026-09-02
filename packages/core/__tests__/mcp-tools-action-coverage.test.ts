import { describe, it, expect } from 'bun:test';
import {
  handleBuilddAction,
  workerActions,
  adminActions,
  type ApiFn,
  type ActionContext,
} from '../mcp-tools';

/**
 * Guards against the class of bug that shipped in PR #1875: an action gets
 * described and added to workerActions/adminActions (so it's advertised in
 * the tool's enum), but no `case` is ever added to handleBuilddAction's
 * switch. handleBuilddAction is the dispatcher every MCP transport besides
 * API-key /api/mcp goes through directly (OAuth /api/mcp-oauth, the
 * in-process runner server) — a missing case there means "Unknown action"
 * for those transports even though the API-key transport works fine (if it
 * has its own inline pre-dispatch special-case, as list_releases/get_release
 * did before this fix).
 *
 * KNOWN_PRE_DISPATCHED: actions that are legitimately absent from
 * handleBuilddAction's switch because every transport (route.ts AND
 * mcp-oauth/route.ts) intercepts them before ever calling handleBuilddAction
 * — not an oversight, an intentional routing decision. Adding an action here
 * requires confirming BOTH transports actually handle it; if only one does,
 * that's this exact bug and belongs in a `case`, not this list.
 */
const KNOWN_PRE_DISPATCHED = new Set([
  // Dispatched via handleMemoryAction before reaching handleBuilddAction, in
  // both /api/mcp/route.ts and /api/mcp-oauth/[workspace]/route.ts.
  'consolidate_knowledge',
  'memory_delete',
]);

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: '00000000-0000-0000-0000-000000000001',
    workerId: undefined,
    authType: 'api',
    getWorkspaceId: async () => '00000000-0000-0000-0000-000000000001',
    getLevel: async () => 'admin', // sail past every level gate to reach the switch
    ...overrides,
  };
}

// A permissive mock: resolves any GET/POST with an empty object, never throws.
// Individual actions may still throw on missing required params — that's
// fine, we only care whether the error is "Unknown action: X".
const permissiveApi: ApiFn = (async () => ({})) as ApiFn;

describe('handleBuilddAction: every advertised action has a reachable case', () => {
  const allActions = [...new Set([...workerActions, ...adminActions])];
  const dispatchable = allActions.filter((a) => !KNOWN_PRE_DISPATCHED.has(a));

  it('KNOWN_PRE_DISPATCHED only lists actions actually still advertised', () => {
    for (const action of KNOWN_PRE_DISPATCHED) {
      expect(allActions).toContain(action);
    }
  });

  it.each(dispatchable)('%s is not "Unknown action"', async (action) => {
    try {
      await handleBuilddAction(permissiveApi, action, {}, ctx());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toMatch(/^Unknown action:/);
    }
  });
});
