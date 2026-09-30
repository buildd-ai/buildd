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
let attributionVerdict = { task_ok: true, worker_ok: true };

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
    // The ledger's attribution check (memoryAttributionCheckSql).
    execute: async () => ({ rows: [attributionVerdict] }),
  },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => null }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async (k: string | null) => (k ? { id: 'acct-1' } : null) }));
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
            "states": [
              "active",
            ],
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
            "states": [
              "active",
            ],
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

  const TEAM = '11111111-1111-4111-8111-111111111111';
  const WS = '22222222-2222-4222-8222-222222222222';
  const TASK = '33333333-3333-4333-8333-333333333333';
  const WORKER = '44444444-4444-4444-8444-444444444444';
  const wsParams = Promise.resolve({ id: WS });
  const ledgerRows = () => (inserts[0].values as any[]).map(r => [r.memoryId, r.rank, r.caller, r.via, r.taskId, r.workerId, r.teamId, r.chunkId]);
  // The ledger write is fire-and-forget after the response: wait for it rather
  // than sleeping a fixed 10ms, which loses the race on a loaded CI runner.
  const untilInserts = async (n: number) => {
    for (let i = 0; i < 200 && inserts.length < n; i++) await new Promise(r => setTimeout(r, 5));
  };
  // Nothing should be written: give a would-be write the same window to show up.
  const settle = () => new Promise(r => setTimeout(r, 50));

  it('a runner search carrying its task writes one ledger INSERT; a dashboard search writes none', async () => {
    teamIdForTest = TEAM;
    attributionVerdict = { task_ok: true, worker_ok: true };
    try {
      await GET(req(`query=fix&limit=5&taskId=${TASK}&workerId=${WORKER}`), { params: wsParams });
      await untilInserts(1);
      expect(inserts).toHaveLength(1);
      // Ranked by the search's order (mem-1 first), not the batch's.
      expect(ledgerRows()).toEqual([
        ['mem-1', 1, 'runner_workspace_memory', 'push', TASK, WORKER, TEAM, null],
        ['mem-2', 2, 'runner_workspace_memory', 'push', TASK, WORKER, TEAM, null],
      ]);

      inserts.length = 0;
      await GET(req('query=fix&limit=5'), { params: wsParams });
      await settle();
      expect(inserts).toHaveLength(0);
    } finally {
      teamIdForTest = 'team-1';
    }
  });

  it('a task id the database does not confirm for this workspace is written unattributed', async () => {
    teamIdForTest = TEAM;
    attributionVerdict = { task_ok: false, worker_ok: true };
    try {
      await GET(req(`query=fix&limit=5&taskId=${TASK}&workerId=${WORKER}`), { params: wsParams });
      await untilInserts(1);
      expect(ledgerRows().map(r => [r[4], r[5]])).toEqual([[null, null], [null, null]]);
    } finally {
      teamIdForTest = 'team-1';
      attributionVerdict = { task_ok: true, worker_ok: true };
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
            "states": [
              "active",
            ],
            "type": undefined,
          },
        ],
      ]
    `);
  });
});
