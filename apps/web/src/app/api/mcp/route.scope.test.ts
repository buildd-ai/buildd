/**
 * Request-scope checks at the /api/mcp entry point.
 *
 * Invariant: a `?workspace=` URL parameter is honoured only when the workspace
 * belongs to the calling token's team, or the calling account is explicitly
 * linked to it. Anything else is refused with one generic 403 before any tool
 * runs, so "does not exist" and "not yours" look the same.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realMcpTools from '@buildd/core/mcp-tools';

const OWN_WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FOREIGN_WS = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LINKED_WS = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TEAM_A = 'team-a';
const TEAM_B = 'team-b';
const ACCOUNT_ID = 'acc-1';

const WORKSPACE_ROWS: Record<string, { teamId: string; dataClass: string; repo: string | null; name: string }> = {
  [OWN_WS]: { teamId: TEAM_A, dataClass: 'standard', repo: null, name: 'own' },
  [FOREIGN_WS]: { teamId: TEAM_B, dataClass: 'standard', repo: null, name: 'foreign' },
  [LINKED_WS]: { teamId: TEAM_B, dataClass: 'standard', repo: null, name: 'linked' },
};

const dialect = new PgDialect();
/** Render a drizzle predicate to SQL text + params so the WHERE is observable. */
function render(where: any): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(where);
  return { sql: q.sql, params: q.params };
}

// The workspace lookup keys on the id param inside the rendered predicate.
// Postgres rejects a non-UUID compared to a uuid column (22P02); the mocks
// throw the same way so a lookup on a malformed id is observable.
function assertUuidParams(params: unknown[]) {
  for (const p of params) {
    if (typeof p === 'string' && !/^[0-9a-f-]{36}$/i.test(p) && !p.startsWith('team-') && !p.startsWith('acc-')) {
      throw new Error('invalid input syntax for type uuid');
    }
  }
}

const mockWorkspacesFindFirst = mock(async (opts: any) => {
  const { params } = render(opts.where);
  assertUuidParams(params);
  const id = params.find(p => typeof p === 'string' && WORKSPACE_ROWS[p as string]) as string | undefined;
  return id ? { id, ...WORKSPACE_ROWS[id] } : null;
});
// Only LINKED_WS carries an explicit link for the calling account.
const linkWheres: any[] = [];
const mockAccountWorkspacesFindFirst = mock(async (opts: any) => {
  linkWheres.push(opts.where);
  const { params } = render(opts.where);
  return params.includes(ACCOUNT_ID) && params.includes(LINKED_WS)
    ? { accountId: ACCOUNT_ID, workspaceId: LINKED_WS }
    : null;
});

const mockAuthenticateApiKey = mock(async () => ({ id: ACCOUNT_ID, level: 'worker', teamId: TEAM_A, authType: 'api' } as any));
const mockHandleRecallAction = mock(async () => ({ content: [{ type: 'text', text: '{"recalled":true}' }] }));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      accountWorkspaces: {
        findFirst: mockAccountWorkspacesFindFirst,
        findMany: mock(async () => []),
      },
      teams: { findFirst: mock(async () => null) },
      workers: {
        findFirst: mock(async (opts: any) => {
          assertUuidParams(render(opts.where).params);
          return null;
        }),
      },
      tasks: { findFirst: mock(async () => null) },
    },
    select: mock(() => ({
      from: mock(() => ({ where: mock(() => ({ limit: mock(async () => []) })) })),
    })),
  },
}));

mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: class {
    upsert() { return Promise.resolve([]); }
    search() { return Promise.resolve([]); }
  },
  getVoyageEmbedder: () => null,
  getVoyageReranker: () => null,
}));

mock.module('@buildd/core/memory-store', () => ({ MemoryStore: class {} }));

mock.module('@/lib/memory-helper', () => ({
  getMemoryStoreForTeam: mock(async () => ({ id: 'store-1' })),
}));

mock.module('@buildd/core/mcp-tools', () => ({
  ...realMcpTools,
  handleBuilddAction: mock(async () => ({ content: [{ type: 'text', text: '{}' }] })),
  handleMemoryAction: mock(async () => ({ content: [{ type: 'text', text: '{}' }] })),
  handleRecallAction: mockHandleRecallAction,
  handleLearnAction: mock(async () => ({ content: [{ type: 'text', text: '{}' }] })),
}));

import { POST } from './route';

function recallRequest(query: string) {
  return new Request(`http://localhost/api/mcp${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer bld_test',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'recall', arguments: { query: 'x' } },
    }),
  });
}

describe('/api/mcp ?workspace= scope', () => {
  beforeEach(() => {
    mockHandleRecallAction.mockClear();
    linkWheres.length = 0;
  });

  it("refuses a workspace owned by another team", async () => {
    const res = await POST(recallRequest(`?workspace=${FOREIGN_WS}`));
    expect(res.status).toBe(403);
    expect(mockHandleRecallAction).not.toHaveBeenCalled();
  });

  it('refuses an unknown workspace with the same response as a foreign one', async () => {
    const unknown = await POST(recallRequest('?workspace=dddddddd-dddd-dddd-dddd-dddddddddddd'));
    const foreign = await POST(recallRequest(`?workspace=${FOREIGN_WS}`));
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual(await foreign.json());
  });

  it('refuses a malformed workspace id with the same 403 as a foreign one', async () => {
    const malformed = await POST(recallRequest('?workspace=not-a-uuid'));
    const foreign = await POST(recallRequest(`?workspace=${FOREIGN_WS}`));
    expect(malformed.status).toBe(403);
    expect(await malformed.json()).toEqual(await foreign.json());
    expect(mockHandleRecallAction).not.toHaveBeenCalled();
  });

  it('refuses a malformed worker id with 403 rather than a server error', async () => {
    const res = await POST(recallRequest(`?workspace=${OWN_WS}&worker=not-a-uuid`));
    expect(res.status).toBe(403);
    expect(mockHandleRecallAction).not.toHaveBeenCalled();
  });

  it("accepts the caller's own team's workspace", async () => {
    const res = await POST(recallRequest(`?workspace=${OWN_WS}`));
    expect(res.status).toBe(200);
    expect(mockHandleRecallAction).toHaveBeenCalled();
  });

  it('accepts a workspace the calling account is explicitly linked to', async () => {
    const res = await POST(recallRequest(`?workspace=${LINKED_WS}`));
    expect(res.status).toBe(200);
    expect(mockHandleRecallAction).toHaveBeenCalled();
  });

  it('keys the link lookup on both the calling account and the requested workspace', async () => {
    await POST(recallRequest(`?workspace=${FOREIGN_WS}`));
    expect(linkWheres.length).toBeGreaterThan(0);
    const { sql, params } = render(linkWheres[0]);
    expect(sql).toContain('"account_id"');
    expect(sql).toContain('"workspace_id"');
    expect(params).toContain(ACCOUNT_ID);
    expect(params).toContain(FOREIGN_WS);
  });
});
