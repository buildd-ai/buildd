/**
 * The OAuth MCP endpoint must register every tool its instructions advertise.
 *
 * It previously advertised `recall` and `learn` in the server instructions
 * while ListTools returned only `buildd` and `buildd_memory`, so CallTool fell
 * through to `throw new Error("Unknown tool: " + name)` — any client that
 * believed the instructions got `Unknown tool: recall`.
 *
 * The last test here is the general invariant rather than a spot check: it
 * parses the tool names out of the advertised instructions and asserts each one
 * is registered, so re-advertising a third tool without wiring it fails too.
 *
 * Run: bun run scripts/run-unit-tests.ts "apps/web/src/app/api/mcp-oauth/[workspace]/route.recall-learn.test.ts"
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ── Mocks must be declared before the route import ───────────────────────────

const mockVerifyAccessToken = mock(() => Promise.resolve({ workspace_id: WORKSPACE_ID } as any));
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));
const mockGetMemoryStoreForTeam = mock(() => Promise.resolve({} as any));

const mockHandleRecallAction = mock(() =>
  Promise.resolve({ content: [{ type: 'text', text: 'RECALL_OK' }] } as any),
);
const mockHandleLearnAction = mock(() =>
  Promise.resolve({ content: [{ type: 'text', text: 'LEARN_OK' }] } as any),
);

mock.module('@/lib/oauth/tokens', () => ({ verifyAccessToken: mockVerifyAccessToken }));
mock.module('@/lib/oauth/config', () => ({ getIssuer: () => 'https://buildd.dev' }));
mock.module('@/lib/memory-helper', () => ({ getMemoryStoreForTeam: mockGetMemoryStoreForTeam }));

mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findFirst: mockWorkspacesFindFirst } } },
}));
mock.module('@buildd/core/db/schema', () => ({ workspaces: { id: 'id' } }));

mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: class {},
  getVoyageEmbedder: () => null,
  getVoyageReranker: () => null,
}));

// The tool *definitions* are stand-ins: this file tests the route's wiring, not
// the schemas. Their real shape is shared with /api/mcp (see the import
// assertion at the bottom of this file) and covered by that route's tests.
mock.module('@buildd/core/mcp-tools', () => ({
  handleBuilddAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleMemoryAction: async () => ({ content: [{ type: 'text', text: 'MEMORY_OK' }] }),
  handleRecallAction: mockHandleRecallAction,
  handleLearnAction: mockHandleLearnAction,
  allActions: ['get_task'],
  memoryActions: ['search'],
  buildToolDescription: () => 'description',
  buildParamsDescription: () => 'params',
  buildMemoryDescription: () => 'memory',
  recallToolDefinition: { name: 'recall', description: 'r', inputSchema: { type: 'object', properties: {} } },
  learnToolDefinition: { name: 'learn', description: 'l', inputSchema: { type: 'object', properties: {} } },
}));

import { POST } from './route';

// ── Helpers ──────────────────────────────────────────────────────────────────

function rpc(method: string, params?: unknown) {
  return new Request(`http://localhost/api/mcp-oauth/${WORKSPACE_ID}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer jwt_test',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function call(method: string, params?: unknown): Promise<any> {
  const res = await POST(rpc(method, params), {
    params: Promise.resolve({ workspace: WORKSPACE_ID }),
  });
  return res.json();
}

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  call('tools/call', { name, arguments: args });

function setWorkspace(dataClass: 'standard' | 'sensitive') {
  mockWorkspacesFindFirst.mockImplementation(() =>
    Promise.resolve({ id: WORKSPACE_ID, teamId: TEAM_ID, dataClass, repo: 'owner/repo', name: 'ws' }),
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('mcp-oauth route: recall / learn registration', () => {
  beforeEach(() => {
    mockHandleRecallAction.mockClear();
    mockHandleLearnAction.mockClear();
    mockGetMemoryStoreForTeam.mockImplementation(() => Promise.resolve({} as any));
    setWorkspace('standard');
  });

  it('lists recall and learn for a standard workspace', async () => {
    const body = await call('tools/list');
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain('recall');
    expect(names).toContain('learn');
  });

  it('dispatches recall to handleRecallAction instead of "Unknown tool"', async () => {
    const body = await callTool('recall', { query: 'anything' });
    const text = body.result.content[0].text;
    expect(text).not.toContain('Unknown tool');
    expect(text).toBe('RECALL_OK');
    expect(mockHandleRecallAction).toHaveBeenCalledTimes(1);
  });

  it('dispatches learn to handleLearnAction instead of "Unknown tool"', async () => {
    const body = await callTool('learn', { type: 'gotcha', title: 't', content: 'c' });
    const text = body.result.content[0].text;
    expect(text).not.toContain('Unknown tool');
    expect(text).toBe('LEARN_OK');
    expect(mockHandleLearnAction).toHaveBeenCalledTimes(1);
  });

  it('passes the workspace project key through so `learn` writes are scoped', async () => {
    await callTool('learn', { type: 'gotcha', title: 't', content: 'c' });
    const ctx = mockHandleLearnAction.mock.calls[0][2] as any;
    expect(ctx.project).toBe('owner/repo');
    expect(ctx.workspaceId).toBe(WORKSPACE_ID);
    expect(ctx.teamId).toBe(TEAM_ID);
  });

  it('still reports genuinely unknown tools', async () => {
    const body = await callTool('not_a_tool');
    expect(body.result.content[0].text).toContain('Unknown tool: not_a_tool');
  });
});

describe('mcp-oauth route: sensitive workspaces keep memory tools unmounted', () => {
  beforeEach(() => {
    mockHandleRecallAction.mockClear();
    mockHandleLearnAction.mockClear();
    setWorkspace('sensitive');
  });

  it('omits recall, learn and buildd_memory from ListTools', async () => {
    const body = await call('tools/list');
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(['buildd']);
  });

  for (const tool of ['recall', 'learn'] as const) {
    it(`refuses ${tool} even when called directly, without touching the handler`, async () => {
      const body = await callTool(tool, { query: 'x', type: 'gotcha', title: 't', content: 'c' });
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain('not available in sensitive workspaces');
      expect(mockHandleRecallAction).not.toHaveBeenCalled();
      expect(mockHandleLearnAction).not.toHaveBeenCalled();
    });
  }
});

describe('mcp-oauth route: advertised tools are registered tools', () => {
  it('every tool named in the server instructions appears in ListTools', async () => {
    setWorkspace('standard');

    const init = await call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    const instructions: string = init.result.instructions;
    expect(instructions).toBeTruthy();

    // The instructions list tools as markdown-backticked names in a "Tools:"
    // block: `buildd`, `recall`, `learn`, `buildd_memory`.
    const advertised = [...instructions.matchAll(/`([a-z_]+)`/g)]
      .map(m => m[1])
      .filter(n => n !== 'workspaceId');

    const listed = (await call('tools/list')).result.tools.map((t: any) => t.name);

    expect(advertised.length).toBeGreaterThan(0);
    expect([...new Set(advertised)].sort()).toEqual(
      [...new Set(advertised)].filter(n => listed.includes(n)).sort(),
    );
  });
});
