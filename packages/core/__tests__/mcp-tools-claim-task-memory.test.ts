/**
 * Regression test: claim_task pre-injects memory context via ctx.getMemoryClient().
 *
 * Proves that the callback path works: when ctx.getMemoryClient returns a store,
 * the claim response includes the "## Relevant Memory" section.
 *
 * This was previously broken because claim_task used getMemoryClient() (env-var
 * based), which requires MEMORY_API_KEY — a variable not set in any environment.
 * After the service absorption, MemoryStore is in-process and always available when
 * teamId resolves; the callback is the injection point for workers.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { ActionContext } from '../mcp-tools';

const WORKER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const WORKSPACE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// The claim-time key comes from the server-side resolver (memoryProjectKey over
// the workspace and its team), not from the claim payload's repo. Mocked here
// so each test controls what the resolver says.
let resolvedKey: string | null = 'acme/widgets';
const resolverCalls: Array<string | null | undefined> = [];
mock.module('../memory-scope', () => ({
  resolveMemoryProjectKey: async (wsId: string | null | undefined) => {
    resolverCalls.push(wsId);
    return resolvedKey;
  },
  resolveMemoryHitScope: async () => null,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

type ClaimedWorkspace = { id?: string; teamId?: string; repo?: string | null; name?: string | null; dataClass?: string } | null;

const STANDARD_WORKSPACE: ClaimedWorkspace = {
  id: WORKSPACE_ID, teamId: 'team-1', repo: 'https://github.com/Acme/Widgets.git', name: 'widgets', dataClass: 'standard',
};

// The API function: returns workers on claim, open PRs empty
function makeApi(
  memories: Array<{ id: string; type: string; title: string; content: string }>,
  workspace: ClaimedWorkspace = STANDARD_WORKSPACE,
) {
  return mock(async (endpoint: string) => {
    if (endpoint.startsWith('/api/workers/') && !endpoint.includes('claim')) {
      return { status: 'idle', task: { status: 'in_progress' } };
    }
    if (endpoint === '/api/workers/claim') {
      return {
        workers: [
          {
            id: WORKER_ID,
            task: {
              id: TASK_ID,
              title: 'Fix the login bug',
              description: 'Auth fails on empty password',
              workspaceId: WORKSPACE_ID,
              ...(workspace ? { workspace } : {}),
            },
            branch: 'buildd/fix-login',
            openPRs: [],
          },
        ],
      };
    }
    return {};
  });
}

function makeMemoryStore(memories: Array<{ id: string; type: string; title: string; content: string }>) {
  return {
    search: mock(async () => ({ results: memories.map(m => ({ id: m.id })), total: memories.length })),
    batch: mock(async () => ({ memories })),
  };
}

function makeCtx(getMemoryClient?: ActionContext['getMemoryClient']): ActionContext {
  return {
    workspaceId: WORKSPACE_ID,
    authType: 'api',
    getWorkspaceId: async () => WORKSPACE_ID,
    getLevel: async () => 'worker',
    getMemoryClient,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('claim_task memory injection', () => {
  beforeEach(() => {
    resolvedKey = 'acme/widgets';
    resolverCalls.length = 0;
  });

  it('includes Relevant Memory section when ctx.getMemoryClient returns memories', async () => {
    const { handleBuilddAction } = await import('../mcp-tools');

    const memories = [
      { id: 'mem-1', type: 'gotcha', title: 'Auth middleware gotcha', content: 'Always validate token before session lookup' },
    ];
    const store = makeMemoryStore(memories);
    const ctx = makeCtx(() => Promise.resolve(store as any));
    const api = makeApi(memories);

    const result = await handleBuilddAction(api as any, 'claim_task', {}, ctx);

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('## Relevant Memory');
    expect(text).toContain('Auth middleware gotcha');
  });

  it('omits Relevant Memory section when ctx.getMemoryClient returns null', async () => {
    const { handleBuilddAction } = await import('../mcp-tools');

    const ctx = makeCtx(() => Promise.resolve(null));
    const api = makeApi([]);

    const result = await handleBuilddAction(api as any, 'claim_task', {}, ctx);

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).not.toContain('## Relevant Memory');
  });

  it('omits Relevant Memory section when ctx.getMemoryClient is not provided', async () => {
    const { handleBuilddAction } = await import('../mcp-tools');

    const ctx = makeCtx(undefined);
    const api = makeApi([]);

    const result = await handleBuilddAction(api as any, 'claim_task', {}, ctx);

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).not.toContain('## Relevant Memory');
  });

  // Invariant: memory surfaced into a claim comes only from the claimed task's
  // workspace, and never from a sensitive workspace.
  describe('workspace boundary', () => {
    it("scopes the memory search to the claimed task's workspace project", async () => {
      const { handleBuilddAction } = await import('../mcp-tools');
      const store = makeMemoryStore([{ id: 'mem-1', type: 'gotcha', title: 't', content: 'c' }]);
      const getMemoryClient = mock(() => Promise.resolve(store as any));

      await handleBuilddAction(makeApi([]) as any, 'claim_task', {}, makeCtx(getMemoryClient));

      expect(store.search).toHaveBeenCalledTimes(1);
      const searchArgs = (store.search.mock.calls[0] as any[])[0];
      expect(searchArgs.project).toBe('acme/widgets');
      expect(searchArgs.query).toBe('Fix the login bug');
    });

    it("resolves the memory store for the claimed task's workspace", async () => {
      const { handleBuilddAction } = await import('../mcp-tools');
      const store = makeMemoryStore([]);
      const getMemoryClient = mock((_wsId?: string) => Promise.resolve(store as any));

      await handleBuilddAction(makeApi([]) as any, 'claim_task', {}, makeCtx(getMemoryClient));

      expect(getMemoryClient).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('surfaces no memory when the claimed task\'s workspace is sensitive', async () => {
      const { handleBuilddAction } = await import('../mcp-tools');
      const store = makeMemoryStore([{ id: 'mem-1', type: 'gotcha', title: 'Leaked', content: 'c' }]);
      const api = makeApi([], { ...STANDARD_WORKSPACE, dataClass: 'sensitive' });

      const result = await handleBuilddAction(api as any, 'claim_task', {}, makeCtx(() => Promise.resolve(store as any)));

      expect(store.search).not.toHaveBeenCalled();
      expect(result.content[0].text).not.toContain('## Relevant Memory');
    });

    it('searches under the key memoryProjectKey resolves, not one derived from the payload', async () => {
      const { handleBuilddAction } = await import('../mcp-tools');
      resolvedKey = 'resolved/key';
      const store = makeMemoryStore([{ id: 'mem-1', type: 'gotcha', title: 't', content: 'c' }]);

      await handleBuilddAction(makeApi([]) as any, 'claim_task', {}, makeCtx(() => Promise.resolve(store as any)));

      expect(resolverCalls).toEqual([WORKSPACE_ID]);
      expect((store.search.mock.calls[0] as any[])[0].project).toBe('resolved/key');
    });

    it('surfaces no memory when the resolver closes the key (shared with a sensitive workspace)', async () => {
      const { handleBuilddAction } = await import('../mcp-tools');
      resolvedKey = null;
      const store = makeMemoryStore([{ id: 'mem-1', type: 'gotcha', title: 'Leaked', content: 'c' }]);

      const result = await handleBuilddAction(makeApi([]) as any, 'claim_task', {}, makeCtx(() => Promise.resolve(store as any)));

      expect(store.search).not.toHaveBeenCalled();
      expect(result.content[0].text).not.toContain('## Relevant Memory');
    });

    it('surfaces no memory when the claimed task carries no workspace to scope by', async () => {
      const { handleBuilddAction } = await import('../mcp-tools');
      const store = makeMemoryStore([{ id: 'mem-1', type: 'gotcha', title: 'Leaked', content: 'c' }]);

      const result = await handleBuilddAction(makeApi([], null) as any, 'claim_task', {}, makeCtx(() => Promise.resolve(store as any)));

      expect(store.search).not.toHaveBeenCalled();
      expect(result.content[0].text).not.toContain('## Relevant Memory');
    });
  });
});
