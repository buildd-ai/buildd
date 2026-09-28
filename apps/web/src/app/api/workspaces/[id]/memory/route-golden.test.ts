/**
 * GET /api/workspaces/[id]/memory: the runner's `## Workspace Memory` search
 * (apps/runner/src/task-memory-retrieval.ts calls it with `query` / `files`).
 *
 * The golden block was captured before the search was routed through
 * `retrieveMemory` (task d1997424) and must not change: same store call, same
 * JSON back.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const inserts: Array<{ values: unknown }> = [];
let teamIdForTest = 'team-1';

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: async () => ({ id: 'acct-1' }) },
      workspaces: {
        findFirst: async () => ({ id: 'ws-1', repo: 'https://github.com/Acme/Widgets.git', name: 'widgets', teamId: teamIdForTest, dataClass: 'standard' }),
        // No sensitive workspace in the team: the memory key stays open.
        findMany: async () => [],
      },
    },
    insert: () => ({
      values: (values: unknown) => {
        inserts.push({ values });
        return Promise.resolve();
      },
    }),
  },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => null }));
mock.module('@/lib/api-auth', () => ({ hashApiKey: (k: string) => `h:${k}` }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async () => true,
  verifyAccountWorkspaceAccess: async () => true,
}));

const MEMORIES = [
  { id: 'mem-2', type: 'pattern', title: 'Second', content: 'two', files: ['a.ts'], tags: [], project: 'acme/widgets' },
  { id: 'mem-1', type: 'gotcha', title: 'First', content: 'one', files: [], tags: [], project: 'acme/widgets' },
];
const search = mock(async (_q: any) => ({ results: [{ id: 'mem-1' }, { id: 'mem-2' }], total: 9 }));
const batch = mock(async (_ids: string[]) => ({ memories: MEMORIES }));
mock.module('@/lib/memory-helper', () => ({
  getMemoryStoreForTeam: async () => ({ search, batch, teamId: 'team-1' }),
  getMemoryIndexStore: () => ({ upsert: async () => ({}), query: async () => [], delete: async () => {}, listNamespaces: async () => [] }),
}));

const originalNodeEnv = process.env.NODE_ENV;
const { GET } = await import('./route');

function req(qs: string) {
  return new NextRequest(`http://localhost:3000/api/workspaces/ws-1/memory?${qs}`, {
    headers: new Headers({ authorization: 'Bearer bld_test' }),
  });
}
const params = Promise.resolve({ id: 'ws-1' });

beforeEach(() => {
  search.mockClear();
  batch.mockClear();
  inserts.length = 0;
  process.env.NODE_ENV = 'production';
});
afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

describe('golden: GET /api/workspaces/[id]/memory search', () => {
  it('title search: same store call and response', async () => {
    const res = await GET(req('query=fix+login&limit=5'), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "memories": [
          {
            "content": "two",
            "files": [
              "a.ts",
            ],
            "id": "mem-2",
            "project": "acme/widgets",
            "tags": [],
            "title": "Second",
            "type": "pattern",
          },
          {
            "content": "one",
            "files": [],
            "id": "mem-1",
            "project": "acme/widgets",
            "tags": [],
            "title": "First",
            "type": "gotcha",
          },
        ],
        "total": 9,
      }
    `);
    expect(search.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "files": undefined,
            "limit": 5,
            "offset": 0,
            "project": "acme/widgets",
            "query": "fix login",
            "type": undefined,
          },
        ],
      ]
    `);
    expect(batch.mock.calls).toMatchInlineSnapshot(`
      [
        [
          [
            "mem-1",
            "mem-2",
          ],
        ],
      ]
    `);
  });

  it('file-scoped search: same store call and response', async () => {
    const res = await GET(req('limit=5&files=apps/a.ts&files=apps/b.ts,apps/c.ts'), { params });
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "memories": [
          {
            "content": "two",
            "files": [
              "a.ts",
            ],
            "id": "mem-2",
            "project": "acme/widgets",
            "tags": [],
            "title": "Second",
            "type": "pattern",
          },
          {
            "content": "one",
            "files": [],
            "id": "mem-1",
            "project": "acme/widgets",
            "tags": [],
            "title": "First",
            "type": "gotcha",
          },
        ],
        "total": 9,
      }
    `);
    expect(search.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "files": [
              "apps/a.ts",
              "apps/b.ts",
              "apps/c.ts",
            ],
            "limit": 5,
            "offset": 0,
            "project": "acme/widgets",
            "query": undefined,
            "type": undefined,
          },
        ],
      ]
    `);
  });

  it('empty result returns the empty shape', async () => {
    search.mockImplementationOnce(async () => ({ results: [], total: 0 }));
    const res = await GET(req('query=nothing&limit=5'), { params });
    expect(await res.json()).toEqual({ memories: [], total: 0 });
    expect(batch).not.toHaveBeenCalled();
  });

  it('a runner search carrying its task writes one ledger INSERT; a dashboard search writes none', async () => {
    const TEAM = '11111111-1111-4111-8111-111111111111';
    const TASK = '33333333-3333-4333-8333-333333333333';
    const WORKER = '44444444-4444-4444-8444-444444444444';
    teamIdForTest = TEAM;
    try {
      await GET(req(`query=fix&limit=5&taskId=${TASK}&workerId=${WORKER}`), { params });
      await new Promise(r => setTimeout(r, 10));
      expect(inserts).toHaveLength(1);
      // Ranked by the search's order (mem-1 first), not the batch's.
      expect((inserts[0].values as any[]).map(r => [r.memoryId, r.rank, r.caller, r.via, r.taskId, r.workerId, r.teamId, r.chunkId])).toEqual([
        ['mem-1', 1, 'runner_workspace_memory', 'push', TASK, WORKER, TEAM, null],
        ['mem-2', 2, 'runner_workspace_memory', 'push', TASK, WORKER, TEAM, null],
      ]);

      inserts.length = 0;
      await GET(req('query=fix&limit=5'), { params });
      await new Promise(r => setTimeout(r, 10));
      expect(inserts).toHaveLength(0);
    } finally {
      teamIdForTest = 'team-1';
    }
  });

  it('plain list (no query, no files): same store call', async () => {
    const res = await GET(req('limit=50'), { params });
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "memories": [
          {
            "content": "two",
            "files": [
              "a.ts",
            ],
            "id": "mem-2",
            "project": "acme/widgets",
            "tags": [],
            "title": "Second",
            "type": "pattern",
          },
          {
            "content": "one",
            "files": [],
            "id": "mem-1",
            "project": "acme/widgets",
            "tags": [],
            "title": "First",
            "type": "gotcha",
          },
        ],
        "total": 9,
      }
    `);
    expect(search.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "files": undefined,
            "limit": 50,
            "offset": 0,
            "project": "acme/widgets",
            "query": undefined,
            "type": undefined,
          },
        ],
      ]
    `);
  });
});
