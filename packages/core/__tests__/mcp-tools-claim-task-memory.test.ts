/**
 * Regression test: claim_task pre-injects memory context via ctx.getMemoryClient().
 *
 * Before the fix, claim_task used getMemoryClient() (env-var based) which requires
 * MEMORY_API_KEY — a variable that is not set in any environment. As a result, every
 * agent claiming a task received no memory context. This test proves the callback path
 * works: when ctx.getMemoryClient returns a client, the claim response includes the
 * "## Relevant Memory" section.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { ActionContext } from '../mcp-tools';

const WORKER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const WORKSPACE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock memory-client module — getMemoryClient (env-var path) should NOT be called
const mockGetMemoryClient = mock(() => null);

mock.module('../memory-client', () => ({
  getMemoryClient: mockGetMemoryClient,
  MemoryClient: class MockMemoryClient {},
}));

// The API function: returns workers on claim, open PRs empty
function makeApi(memories: Array<{ id: string; type: string; title: string; content: string }>) {
  return mock(async (endpoint: string) => {
    if (endpoint.startsWith('/api/workers/') && !endpoint.includes('claim')) {
      // Pre-assigned worker check (workerId present in ctx)
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMemoryClient(memories: Array<{ id: string; type: string; title: string; content: string }>) {
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
    mockGetMemoryClient.mockReset();
  });

  it('includes Relevant Memory section when ctx.getMemoryClient returns memories', async () => {
    const { handleBuilddAction } = await import('../mcp-tools');

    const memories = [
      { id: 'mem-1', type: 'gotcha', title: 'Auth middleware gotcha', content: 'Always validate token before session lookup' },
    ];
    const client = makeMemoryClient(memories);
    const ctx = makeCtx(() => Promise.resolve(client as any));
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
    // Crucially: the old env-var path must NOT have been called
    expect(mockGetMemoryClient).not.toHaveBeenCalled();
  });

  it('does not call the env-var getMemoryClient even when ctx.getMemoryClient is provided', async () => {
    const { handleBuilddAction } = await import('../mcp-tools');

    const client = makeMemoryClient([{ id: 'm1', type: 'pattern', title: 'T', content: 'C' }]);
    const ctx = makeCtx(() => Promise.resolve(client as any));
    const api = makeApi([]);

    await handleBuilddAction(api as any, 'claim_task', {}, ctx);

    // The env-var singleton should never be touched
    expect(mockGetMemoryClient).not.toHaveBeenCalled();
  });
});
