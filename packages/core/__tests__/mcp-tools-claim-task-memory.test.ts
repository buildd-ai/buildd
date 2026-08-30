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

import { describe, it, expect, mock } from 'bun:test';
import type { ActionContext } from '../mcp-tools';

const WORKER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const WORKSPACE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ── Helpers ───────────────────────────────────────────────────────────────────

// The API function: returns workers on claim, open PRs empty
function makeApi(memories: Array<{ id: string; type: string; title: string; content: string }>) {
  return mock(async (endpoint: string) => {
    if (endpoint.startsWith('/api/workers/') && !endpoint.includes('claim')) {
      return { status: 'idle', task: { status: 'in_progress' } };
    }
    if (endpoint === '/api/workers/claim') {
      return {
        workers: [
          {
            id: WORKER_ID,
            task: { id: TASK_ID, title: 'Fix the login bug', description: 'Auth fails on empty password' },
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
});
